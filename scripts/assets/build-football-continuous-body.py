"""Pinned MakeHuman anatomical body -> unchanged Football 49-joint bind.

Python stdlib only. Keeps ALL OBJ vertex IDs (including authoring helpers) in the
binding map, while exported visible triangles contain the anatomical body only.
Import build_binding() and garment_position() for MHCLO correspondence transfer.
The exported positions are a new rest mesh; skinning must use the production
translation-only rest hierarchy and its matching inverse bind matrices.
"""
from __future__ import annotations
import argparse
from collections import defaultdict, Counter
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import struct

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = ROOT / 'docs/games/virtual-football-continuous-player-contract.json'
PINS = {
    'source': '8e761e6624b8f54536409135d1636da63b32486a90d4897f84e121d144f6fb4c',
    'skeleton': '99f179bce0aa850b45d4191a1d0d234c5851f881c057439470ded3bddf729a24',
    'weights': '0f3641d651ae3d00ad6b4ccee43142edb109d3bd909d27d9e4139ef1beed8625',
}
I = [.12, 0., 0., 0., .12, 0., 0., 0., .12]
HEAD_T = [0., 1.5 - 5.89 * .12, -.161 * .12]


def require(value, message):
    if not value:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def add(a, b):
    return [a[i] + b[i] for i in range(3)]


def sub(a, b):
    return [a[i] - b[i] for i in range(3)]


def scale(a, s):
    return [x * s for x in a]


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def norm(a):
    return math.sqrt(dot(a, a))


def unit(a):
    length = norm(a)
    require(length > 1e-10, 'Degenerate frame direction')
    return scale(a, 1 / length)


def cross(a, b):
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]


def mv(m, p):
    return [dot(m[3*i:3*i+3], p) for i in range(3)]


def point(transform, p):
    return add(mv(transform['matrix'], p), transform['translation'])


def frame(direction, hint):
    y = unit(direction)
    x = sub(hint, scale(y, dot(hint, y)))
    if norm(x) < 1e-6:
        x = sub([1., 0., 0.], scale(y, y[0]))
    x = unit(x)
    z = unit(cross(x, y))
    return [x, y, z]


def affine_segment(a, b, c, d, hint=(0., 0., 1.), target_hint=None, width=.12):
    """Map source segment endpoints exactly, keeping transverse anatomical scale.

    Source and target frames have identical positive handedness. The affine
    stretches only along the bone; no reflected finger or limb transform.
    """
    source = frame(sub(b, a), hint)
    target = frame(sub(d, c), target_hint if target_hint is not None else hint)
    lengths = [width, norm(sub(d, c))/norm(sub(b, a)), width]
    matrix = [sum(target[k][r] * lengths[k] * source[k][col] for k in range(3))
              for r in range(3) for col in range(3)]
    result = {'matrix': matrix, 'translation': sub(c, mv(matrix, a)),
              'sourceHead': a, 'sourceTail': b, 'targetHead': c, 'targetTail': d,
              'axialScale': lengths[1], 'transverseScale': width}
    require(norm(sub(point(result, a), c)) < 1e-9 and norm(sub(point(result, b), d)) < 1e-9,
            'Segment endpoint fit failed')
    return result


def smoothstep(a,b,x):
    t=max(0.,min(1.,(x-a)/(b-a)))
    return t*t*(3-2*t)


def athletic_torso(position, trunk_weight):
    """Original bounded neutral torso adjustment; topology and contact rig stay fixed.

    Only positive-Z chest volume is reduced. Broad waist adjustment avoids the
    source foundation's hourglass silhouette. The full derivative is composed
    into the garment-offset transform; the neck join region is untouched.
    """
    x,y,z=position
    chest = smoothstep(1.12,1.22,y)*(1-smoothstep(1.36,1.47,y))
    front = smoothstep(.07,.15,z)
    waist = smoothstep(.96,1.04,y)*(1-smoothstep(1.15,1.25,y))
    return [x*(1+.15*waist*trunk_weight),y,
            z-.60*chest*front*max(0.,z-.07)*trunk_weight]


def reshape_with_derivative(position, matrix, trunk_weight):
    q=athletic_torso(position,trunk_weight)
    eps=1e-6
    columns=[]
    for axis in range(3):
        positive=position[:];negative=position[:]
        positive[axis]+=eps;negative[axis]-=eps
        columns.append(scale(sub(athletic_torso(positive,trunk_weight),
                                 athletic_torso(negative,trunk_weight)),.5/eps))
    correction=[columns[col][row] for row in range(3)for col in range(3)]
    composed=[sum(correction[r*3+k]*matrix[k*3+c]for k in range(3))for r in range(3)for c in range(3)]
    return q,composed


def load_obj(raw):
    positions, uv, faces, groups = [], [], [], []
    group = ''
    for line in raw.decode().splitlines():
        fields = line.split()
        if not fields:
            continue
        if fields[0] == 'v':
            positions.append(list(map(float, fields[1:4])))
        elif fields[0] == 'vt':
            uv.append(list(map(float, fields[1:3])))
        elif fields[0] == 'g':
            group = fields[1]
        elif fields[0] == 'f' and group == 'body':
            corners = [[int(c.split('/')[0])-1, int(c.split('/')[1])-1] for c in fields[1:]]
            for j in range(1, len(corners)-1):
                faces.append([corners[0], corners[j], corners[j+1]])
        elif fields[0] == 'g':
            groups.append(group)
    return positions, uv, faces


def cap_weights(weights, limit=4):
    ordered = sorted(((int(i), float(w)) for i, w in weights if w > 0), key=lambda v: (-v[1], v[0]))
    total = sum(w for _, w in ordered)
    require(total > 0, 'Unweighted surface vertex')
    normalized = [(i, w/total) for i, w in ordered]
    keep = normalized[:limit]
    kept = sum(w for _, w in keep)
    indices = [i for i, _ in keep] + [0] * (limit-len(keep))
    values = [w/kept for _, w in keep] + [0.] * (limit-len(keep))
    return indices, values, 1-kept, normalized


def transform_offset(binding, source_vertex_id, offset):
    """Offset is in original native OBJ units; result is production metres."""
    return mv(binding['vertexTransforms'][source_vertex_id], offset)


def garment_position(binding, ids, coefficients, offset):
    """MHCLO barycentric native surface + native offset -> production bind.

    Callers must evaluate MHCLO x/y/z scale rules BEFORE passing offset. This
    uses full, pre-cap native bind blend derivatives for garment shell offsets.
    """
    return [sum(coefficients[k] * (binding['positions'][ids[k]][axis] +
                 transform_offset(binding, ids[k], offset)[axis]) for k in range(len(ids)))
            for axis in range(3)]


def build_binding(source_path, skeleton_path, weights_path, contract_path=CONTRACT):
    raws = {k: Path(p).read_bytes() for k, p in
            [('source', source_path), ('skeleton', skeleton_path), ('weights', weights_path)]}
    for kind, raw in raws.items():
        require(sha(raw) == PINS[kind], f'Unpinned {kind} input')
    positions, uv, faces = load_obj(raws['source'])
    skel = json.loads(raws['skeleton'])
    native_weights = json.loads(raws['weights'])['weights']
    contract_raw = Path(contract_path).read_bytes()
    contract = json.loads(contract_raw)['rig']
    names = contract['boneOrder']
    require(len(names) == 49 and len(set(names)) == 49, 'Expected49 joint contract')
    rest = {n: contract['bones'][n]['worldMetres'] for n in names}
    joints = {name: [sum(positions[i][axis] for i in ids)/len(ids) for axis in range(3)]
              for name, ids in skel['joints'].items()}
    def end(name, key):
        return joints[skel['bones'][name][key]]
    transforms, mapping = {}, {}
    fixed_head = {'matrix': I[:], 'translation': HEAD_T[:]}
    spine_targets = {'spine05': (.95, 1.0), 'spine04': (1.0, 1.05),
                     'spine03': (1.05, 1.16), 'spine02': (1.16, 1.27), 'spine01': (1.27, 1.5)}
    spine_mapping = {'spine05': 'hips', 'spine04': 'hips', 'spine03': 'spine',
                     'spine02': 'spine', 'spine01': 'chest'}
    for name, (low, high) in spine_targets.items():
        transforms[name] = affine_segment(end(name,'head'), end(name,'tail'), [0.,low,0.], [0.,high,0.], (1.,0.,0.))
        mapping[name] = spine_mapping[name]
    transforms['root'] = transforms['spine05']
    mapping['root'] = 'hips'
    for n in ['neck01','neck02','neck03','head']:
        transforms[n] = fixed_head
        mapping[n] = 'neck' if n.startswith('neck') else 'head'
    for side in ['L', 'R']:
        suffix = '.'+side
        arm = affine_segment(end('upperarm01'+suffix,'head'), end('upperarm02'+suffix,'tail'),
                             rest['upperArm'+side], rest['foreArm'+side])
        forearm = affine_segment(end('lowerarm01'+suffix,'head'), end('lowerarm02'+suffix,'tail'),
                                 rest['foreArm'+side], rest['hand'+side])
        # Palm roll is constrained by index-to-pinky spread, not guessed from a
        # single longitudinal vector. This removes the source's forward wrist bend.
        across = sub(end('finger2-1'+suffix,'head'), end('finger5-1'+suffix,'head'))
        target_across = sub(rest['index1'+side], rest['pinky1'+side])
        palm = affine_segment(end('wrist'+suffix,'head'), end('finger3-1'+suffix,'head'),
                              rest['hand'+side], rest['middle1'+side], across, target_across)
        thigh = affine_segment(end('upperleg01'+suffix,'head'), end('upperleg02'+suffix,'tail'),
                               rest['upperLeg'+side], rest['lowerLeg'+side])
        shin = affine_segment(end('lowerleg01'+suffix,'head'), end('lowerleg02'+suffix,'tail'),
                              rest['lowerLeg'+side], rest['foot'+side])
        # Align foot ankle->native second-toe base to unchanged runtime toe root.
        foot = affine_segment(end('foot'+suffix,'head'), end('toe2-1'+suffix,'head'),
                              rest['foot'+side], rest['toe'+side], (1.,0.,0.))
        for n in ['upperarm01','upperarm02','shoulder01']:
            transforms[n+suffix], mapping[n+suffix] = arm, 'upperArm'+side
        for n in ['lowerarm01','lowerarm02']:
            transforms[n+suffix], mapping[n+suffix] = forearm, 'foreArm'+side
        transforms['wrist'+suffix], mapping['wrist'+suffix] = palm, 'hand'+side
        for n in ['upperleg01','upperleg02']:
            transforms[n+suffix], mapping[n+suffix] = thigh, 'upperLeg'+side
        for n in ['lowerleg01','lowerleg02']:
            transforms[n+suffix], mapping[n+suffix] = shin, 'lowerLeg'+side
        transforms['foot'+suffix], mapping['foot'+suffix] = foot, 'foot'+side
        for n in range(1,5):
            transforms[f'metacarpal{n}'+suffix], mapping[f'metacarpal{n}'+suffix] = palm, 'hand'+side
        for finger, label in enumerate(['thumb','index','middle','ring','pinky'], 1):
            for segment in range(1,4):
                native = f'finger{finger}-{segment}'+suffix
                target = f'{label}{segment}'+side
                c = rest[target]
                if segment < 3:
                    d = rest[f'{label}{segment+1}'+side]
                else:
                    direction = unit(sub(c, rest[f'{label}2'+side]))
                    d = add(c, scale(direction, .12*norm(sub(end(native,'tail'),end(native,'head')))))
                transforms[native] = affine_segment(end(native,'head'),end(native,'tail'),c,d,across,target_across)
                mapping[native] = target
        for native in skel['bones']:
            if native.startswith('toe') and native.endswith(suffix):
                transforms[native], mapping[native] = foot, 'toe'+side
        for n in ['pelvis']:
            transforms[n+suffix], mapping[n+suffix] = transforms['spine05'], 'hips'
        for n in ['clavicle','breast']:
            transforms[n+suffix], mapping[n+suffix] = transforms['spine01' if n == 'clavicle' else 'spine02'], 'chest'
    # Facial authoring controls collapse onto head. No silent unmapped weighted group.
    for native in skel['bones']:
        if native not in mapping:
            ancestor = native
            while ancestor is not None and ancestor != 'head':
                ancestor = skel['bones'][ancestor]['parent']
            require(ancestor == 'head', f'Unmapped nonfacial native bone {native}')
            mapping[native], transforms[native] = 'head', fixed_head
    require(set(native_weights) <= set(mapping), 'Unmapped source influence')
    per_vertex = [[] for _ in positions]
    for native, entries in native_weights.items():
        for index, weight in entries:
            require(0 <= index < len(positions) and weight >= 0, 'Invalid native weight')
            if weight:
                per_vertex[index].append((native,weight))
    surface_ids = sorted({i for f in faces for i,_ in f})
    require(len(surface_ids) == 13380, 'Anatomical source topology drift')
    output, matrices, full_weights, indices, weights, losses, fallback = [], [], [], [], [], [], []
    for i, p in enumerate(positions):
        entries = per_vertex[i]
        if not entries:
            # Authoring-only unweighted helper vertices use head frame. They are
            # retained for ID correspondence and never emitted as visible skin.
            require(i not in surface_ids, f'Unweighted anatomical vertex {i}')
            fallback.append(i)
            entries = [('head',1.)]
        total = sum(w for _,w in entries)
        entries = [(n,w/total) for n,w in entries]
        q = [sum(point(transforms[n],p)[axis]*w for n,w in entries) for axis in range(3)]
        matrix = [sum(transforms[n]['matrix'][axis]*w for n,w in entries) for axis in range(9)]
        # The anatomical head boundary must coincide with the accepted review head.
        # Source rest at y>=5.68 is held EXACTLY, with a C1 shoulder/neck transition.
        blend = max(0., min(1., (p[1]-5.15)/(.53)))
        blend = blend*blend*(3-2*blend)
        if blend:
            q = add(scale(q,1-blend), scale(point(fixed_head,p),blend))
            matrix = [(1-blend)*matrix[a] + blend*I[a] for a in range(9)]
        trunk_weight = sum(w for native,w in entries if mapping[native] in ['hips','spine','chest'])
        q,matrix = reshape_with_derivative(q,matrix,trunk_weight)
        merged = defaultdict(float)
        for native,w in entries:
            merged[names.index(mapping[native])] += w
        # Neck/head use the runtime head adapter's anatomical blend at upper neck.
        if p[1] >= 5.15:
            head_part = max(0., min(1., (q[1]-1.49)/.11))
            merged = defaultdict(float, {names.index('neck'):1-head_part, names.index('head'):head_part})
        si,sw,loss,full = cap_weights(merged.items())
        output.append(q); matrices.append(matrix); full_weights.append(full)
        indices.append(si); weights.append(sw); losses.append(loss)
    for i in surface_ids:
        require(abs(sum(weights[i])-1.) < 1e-12 and all(math.isfinite(v) for v in output[i]), 'Invalid bind')
    return {'schemaVersion':1, 'generator':'original-football-continuous-body-v1',
        'sourceSHA256':PINS['source'], 'nativeSkeletonSHA256':PINS['skeleton'], 'nativeWeightsSHA256':PINS['weights'],
        'contractSHA256':sha(contract_raw), 'jointNames49':names, 'productionRest':contract['bones'],
        'sourcePositions':positions, 'positions':output, 'vertexTransforms':matrices,
        'skinIndices':indices, 'skinWeights':weights, 'normalized49Weights':full_weights,
        'sourceUV':uv, 'bodyTriangles':faces, 'bodySourceVertexIds':surface_ids,
        'nativeBoneToProduction':mapping, 'nativeBoneTransforms':transforms,
        'athleticTorsoReshape':{'authorship':'Original bounded PlayQube proportional adjustment',
            'frontChestYRange':[1.12,1.47],'frontChestZRange':[.07,.15],
            'maxAnteriorCompression':.60,'waistYRange':[.96,1.25],'maxWaistExpansion':.15,
            'derivative':'Central numeric production-space derivative, composed with native retarget3x3'},
        'headBoundary':{'sourceYMin':5.68, 'matrix':I, 'translation':HEAD_T,
                        'note':'Root integration applies identical head postfit/seam trimming to matching original source IDs.'},
        'weightAudit':{'sourceVertexCount':len(positions), 'anatomicalVertices':len(surface_ids),
            'anatomicalTriangles':len(faces), 'nativeWeightedBoneGroups':len(native_weights),
            'nativeBones':len(skel['bones']), 'unweightedAuthoringHelperIds':fallback,
            'cappedAnatomicalVertices':sum(losses[i]>1e-12 for i in surface_ids),
            'maximumDiscardedAnatomicalWeight':max(losses[i] for i in surface_ids),
            'meanDiscardedAnatomicalWeight':sum(losses[i] for i in surface_ids)/len(surface_ids)},
        'limits':['Offline linear blend rest retarget; final shoulder/hip compression needs posed visual validation.',
                  'Body topology includes anatomical head until runtime seam join; helper faces are excluded.',
                  'vertexTransforms freeze original correspondence weights and are offset transforms, not derivatives of a spatial weight field.']}


def export_glb(binding, source_raw, head_raw, plane=1.53):
    """Build one real skinned GLB, clipping source triangles at the head join.

    Clip ALL neutral attributes and all8 relative morphs with the same edge t.
    Accepted review-head normals/morphs are copied by original OBJ correspondence
    before clipping, including both endpoints of every intersected source edge.
    """
    spec = importlib.util.spec_from_file_location('review_head_export', ROOT/'scripts/assets/build-football-review-head.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    head, head_bin = module.read_glb(head_raw)
    primitive = head['meshes'][0]['primitives'][0]
    head_indices = [v[0] for v in module.rows(head,head_bin,primitive['indices'])]
    head_normals = module.rows(head,head_bin,primitive['attributes']['NORMAL'])
    head_positions = module.rows(head,head_bin,primitive['attributes']['POSITION'])
    head_targets = [{name:module.rows(head,head_bin,index) for name,index in target.items()} for target in primitive['targets']]
    _,_,head_faces,_,_ = module.source_faces(source_raw)
    correspondence = {}
    for corner,(source_id,_) in enumerate(c for f in head_faces for c in f):
        vertex = head_indices[corner]
        if source_id in correspondence:
            old = correspondence[source_id]
            require(head_normals[old] == head_normals[vertex], 'Head UV seam has normal split')
        correspondence[source_id] = vertex
    p = binding['positions']
    native = binding['sourcePositions']
    normals = [[0.,0.,0.] for _ in p]
    for face in binding['bodyTriangles']:
        a,b,c = (q[0] for q in face)
        n = cross(sub(p[b],p[a]),sub(p[c],p[a]))
        for i in [a,b,c]:
            normals[i] = add(normals[i],n)
    for i in binding['bodySourceVertexIds']:
        normals[i] = unit(normals[i])
    head_boundary = [i for i in correspondence if p[i][1] < 1.50]
    attributes, source_blends, vertices, triangles = [], [], {}, []
    morph_names = head['meshes'][0]['extras']['targetNames']
    require(len(morph_names)==8,'Expected8 accepted head morphs')
    def source_vertex(source_id, uv_id):
        key = ('source',source_id,uv_id)
        if key in vertices:
            return vertices[key]
        hi = correspondence.get(source_id)
        if hi is not None:
            # Exact float32 source head positions also make cut interpolation
            # numerically identical to the accepted head exporter.
            position = list(head_positions[hi])
            normal = list(head_normals[hi])
            targets = [{k:list(values[hi]) for k,values in target.items()} for target in head_targets]
        else:
            position, normal = p[source_id], normals[source_id]
            targets = [{'POSITION':[0.,0.,0.],'NORMAL':[0.,0.,0.]} for _ in morph_names]
            # Continue only lower-neck jaw response smoothly below the retained
            # source-head boundary. Native anatomical vertices stay connected.
            if 1.42 < position[1] < 1.50:
                nearest = min(head_boundary,key=lambda i:sum((native[i][a]-native[source_id][a])**2 for a in [0,2]))
                hv = correspondence[nearest]
                t = max(0.,min(1.,(position[1]-1.42)/(1.4748-1.42)))
                t = t*t*(3-2*t)
                targets = [{k:scale(values[hv],t) for k,values in target.items()} for target in head_targets]
        u,v = binding['sourceUV'][uv_id]
        result = {'POSITION':position,'NORMAL':normal,'TEXCOORD_0':[u,1-v],'TEXCOORD_1':[u,1-v],
                  'weights':binding['normalized49Weights'][source_id], 'targets':targets}
        index = len(attributes)
        attributes.append(result); source_blends.append([[source_id,1.]])
        vertices[key] = index
        return index
    def interpolate(a,b):
        pa,pb = attributes[a]['POSITION'],attributes[b]['POSITION']
        t = (plane-pa[1])/(pb[1]-pa[1])
        key = ('clip',min(a,b),max(a,b))
        if key in vertices:
            return vertices[key]
        def mix(x,y):
            return [(1-t)*q+t*r for q,r in zip(x,y)]
        av,bv = attributes[a],attributes[b]
        result = {name:mix(av[name],bv[name]) for name in ['POSITION','NORMAL','TEXCOORD_0','TEXCOORD_1']}
        result['POSITION'][1] = plane
        weights = defaultdict(float)
        for joint,weight in av['weights']:
            weights[joint] += weight*(1-t)
        for joint,weight in bv['weights']:
            weights[joint] += weight*t
        result['weights'] = list(weights.items())
        result['targets'] = [{name:mix(x[name],y[name]) for name in ['POSITION','NORMAL']}
                             for x,y in zip(av['targets'],bv['targets'])]
        index = len(attributes);attributes.append(result)
        blend = defaultdict(float)
        for i,weight in source_blends[a]:blend[i]+=weight*(1-t)
        for i,weight in source_blends[b]:blend[i]+=weight*t
        source_blends.append(list(blend.items()));vertices[key]=index
        return index
    for face in binding['bodyTriangles']:
        corners = [source_vertex(i,uv) for i,uv in face]
        clipped = []
        for j,a in enumerate(corners):
            b = corners[(j+1)%3]
            inside_a = attributes[a]['POSITION'][1] <= plane
            inside_b = attributes[b]['POSITION'][1] <= plane
            if inside_a:clipped.append(a)
            if inside_a != inside_b:clipped.append(interpolate(a,b))
        for j in range(1,len(clipped)-1):
            triangles.append([clipped[0],clipped[j],clipped[j+1]])
    used = sorted({i for f in triangles for i in f})
    remap = {old:new for new,old in enumerate(used)}
    output_vertices = [attributes[i] for i in used]
    output_sources = [source_blends[i] for i in used]
    flat_indices = [remap[i] for f in triangles for i in f]
    names = binding['jointNames49']
    nodes = [{'name':name,'translation':binding['productionRest'][name]['localMetres']} for name in names]
    for i,name in enumerate(names):
        parent = binding['productionRest'][name]['parent']
        if parent is not None:
            nodes[names.index(parent)].setdefault('children',[]).append(i)
    nodes.append({'name':'continuous-body','mesh':0,'skin':0})
    doc = {'asset':{'version':'2.0','generator':'Original Football continuous anatomical body bind v1'},
           'scene':0,'scenes':[{'nodes':[0,49]}],'nodes':nodes,
           'meshes':[{'name':'continuous-body','primitives':[{}],'weights':[0.]*8,
                      'extras':{'targetNames':morph_names,'sourceSHA256':PINS['source'],
                                'clipPlaneY':plane,'sourceBodyTriangles':len(binding['bodyTriangles']),
                                'nativeWeightSourceSHA256':PINS['weights']}}],
           'materials':[{'name':'continuous-source-skin','pbrMetallicRoughness':{'baseColorFactor':[1.,1.,1.,1.],
                         'metallicFactor':0.,'roughnessFactor':.72}}],
           'accessors':[],'bufferViews':[],'skins':[{'name':'Football49','joints':list(range(49)),'skeleton':0}]}
    blob = bytearray()
    def accessor(values,kind,component=5126,bounds=False):
        fmt = {5126:'f',5123:'H',5125:'I'}[component]
        width = {'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}[kind]
        require(all(len(v)==width for v in values),'Invalid attribute width')
        blob.extend(b'\0'*(-len(blob)%4));offset=len(blob)
        blob.extend(struct.pack('<'+fmt*(width*len(values)),*(v for row in values for v in row)))
        doc['bufferViews'].append({'buffer':0,'byteOffset':offset,'byteLength':len(blob)-offset})
        item = {'bufferView':len(doc['bufferViews'])-1,'componentType':component,'count':len(values),'type':kind}
        if bounds:
            item['min']=[min(v[i] for v in values)for i in range(width)]
            item['max']=[max(v[i] for v in values)for i in range(width)]
        doc['accessors'].append(item)
        return len(doc['accessors'])-1
    out = doc['meshes'][0]['primitives'][0]
    out['attributes'] = {n:accessor([v[n] for v in output_vertices],kind,bounds=n=='POSITION') for n,kind in
                         [('POSITION','VEC3'),('NORMAL','VEC3'),('TEXCOORD_0','VEC2'),('TEXCOORD_1','VEC2')]}
    capped = [cap_weights(v['weights']) for v in output_vertices]
    out['attributes']['JOINTS_0']=accessor([c[0]for c in capped],'VEC4',5123)
    out['attributes']['WEIGHTS_0']=accessor([c[1]for c in capped],'VEC4')
    out['indices']=accessor([(i,)for i in flat_indices],'SCALAR',5123 if len(used)<65536 else 5125)
    out['material']=0
    out['targets']=[{n:accessor([v['targets'][i][n]for v in output_vertices],'VEC3',bounds=n=='POSITION')for n in ['POSITION','NORMAL']}
                    for i in range(8)]
    inverses = []
    for name in names:
        x,y,z=binding['productionRest'][name]['worldMetres']
        inverses.append([1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.,0.,-x,-y,-z,1.])
    doc['skins'][0]['inverseBindMatrices']=accessor(inverses,'MAT4')
    raw=module.encode(doc,blob)
    # Independently reparse accessors, checking every retained skin and target.
    module.SIZES['MAT4']=16
    verify, binary=module.read_glb(raw)
    require(len(module.rows(verify,binary,out['attributes']['POSITION']))==len(used),'GLB position loss')
    for row in module.rows(verify,binary,out['attributes']['WEIGHTS_0']):
        require(abs(sum(row)-1)<2e-7,'Non-normalized exported skin')
    report={'sha256':sha(raw),'bytes':len(raw),'vertices':len(used),'triangles':len(triangles),
            'joints':49,'morphNames':morph_names,'clipPlaneY':plane,'originalVertexCorrespondence':output_sources,
            'sourceHeadSHA256':sha(head_raw),'maximumCapLoss':max(v[2]for v in capped)}
    return raw,report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('skeleton', type=Path)
    parser.add_argument('weights', type=Path)
    parser.add_argument('--contract', type=Path, default=CONTRACT)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--glb', action='store_true', help='Also build clipped49-joint GLB with accepted head neck morphs')
    args = parser.parse_args()
    binding = build_binding(args.source,args.skeleton,args.weights,args.contract)
    raw = (json.dumps(binding,separators=(',',':'))+'\n').encode()
    path = args.output/'continuous-body-bind.json'
    report = {'status':'PASS','bindingSHA256':sha(raw),'bindingBytes':len(raw),
              'authoringScriptSHA256':sha(Path(__file__).read_bytes()),'weightAudit':binding['weightAudit'],
              'sourcePins':PINS,'jointNames49':binding['jointNames49'],'limits':binding['limits']}
    report_raw = (json.dumps(report,indent=2)+'\n').encode()
    if args.check:
        require(path.read_bytes() == raw, 'Body binding export drift')
        require((args.output/'continuous-body-bind-report.json').read_bytes() == report_raw,'Body report drift')
    else:
        args.output.mkdir(parents=True,exist_ok=True)
        path.write_bytes(raw)
        (args.output/'continuous-body-bind-report.json').write_bytes(report_raw)
    if args.glb:
        glb, glb_report = export_glb(binding,args.source.read_bytes(),(ROOT/'apps/web/public/models/football/review-head-high.glb').read_bytes())
        glb_path=args.output/'continuous-body.glb'
        glb_report_raw=(json.dumps(glb_report,separators=(',',':'))+'\n').encode()
        if args.check:
            require(glb_path.read_bytes()==glb,'Body GLB export drift')
            require((args.output/'continuous-body-glb-report.json').read_bytes()==glb_report_raw,'Body GLB report drift')
        else:
            glb_path.write_bytes(glb)
            (args.output/'continuous-body-glb-report.json').write_bytes(glb_report_raw)
    print(json.dumps({k:v for k,v in report.items() if k!='weightAudit'} | {'audit':{k:v for k,v in binding['weightAudit'].items() if k!='unweightedAuthoringHelperIds'}},indent=2))


if __name__ == '__main__':
    main()
