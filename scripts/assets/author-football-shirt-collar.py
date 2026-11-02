"""Original neutral collar control-mesh edit; no download/DCC/pose simulation.

The pinned MHCLO-derived jersey keeps every UV corner, index and joint weight.
Eleven existing 26-point rings are laid out as a continuous sewn transition,
replacing the near-coplanar reversed outer return that produced a black seam.
The fixed body ring and next body ring define the endpoint and tangent.

Edit the 26 explicit neckline controls and tangentScale in the source JSON,
then run --write; --check reconstructs every derived target without writes.
"""
from pathlib import Path
import argparse, collections, hashlib, json, math, struct
ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT/'apps/web/src/components/football/engine/continuous-shirt-collar-source.json'
MODEL = ROOT/'apps/web/public/models/football/continuous-jersey.glb'

def require(value, message):
    if not value: raise ValueError(message)

def source_mesh(raw):
    length = struct.unpack_from('<I', raw, 12)[0]
    doc = json.loads(raw[20:20+length]); data = raw[28+length:]
    def accessor(index):
        a=doc['accessors'][index]; view=doc['bufferViews'][a['bufferView']]
        kind={5123:'H',5125:'I',5126:'f'}[a['componentType']]
        size={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']]
        return [struct.unpack_from('<'+kind*size, data, view.get('byteOffset',0)+a.get('byteOffset',0)+i*view.get('byteStride',struct.calcsize(kind)*size)) for i in range(a['count'])]
    primitive=doc['meshes'][0]['primitives'][0]
    return accessor(primitive['attributes']['POSITION']), [v[0] for v in accessor(primitive['indices'])]

def rebuild(data):
    raw=MODEL.read_bytes();require(hashlib.sha256(raw).hexdigest()==data['source']['sha256'],'Pinned source jersey differs')
    positions,indices=source_mesh(raw);representative=[];canonical={}
    for i,point in enumerate(positions):representative.append(canonical.setdefault(tuple(round(v,7) for v in point),i))
    adjacency=collections.defaultdict(set)
    for k in range(0,len(indices),3):
        triangle=[representative[i] for i in indices[k:k+3]]
        for i in triangle:adjacency[i].update(j for j in triangle if i!=j)
    controls=data['controls'];distance={representative[c['sourceVertex']]:0 for c in controls};queue=collections.deque(distance)
    for c in controls:require(list(positions[c['sourceVertex']])==c['sourcePosition'],'Source control identity differs')
    while queue:
        i=queue.popleft()
        for j in adjacency[i]:
            if j not in distance:distance[j]=distance[i]+1;queue.append(j)
    layers=[[i for i,d in distance.items() if d==level] for level in range(12)]
    require(all(len(layer)==26 for layer in layers),'Expected eleven collar rings and fixed body tangent ring')
    def angle(point):return math.atan2(point[2]-.007,point[0])
    root=sorted(range(26),key=lambda k:angle(controls[k]['sourcePosition']))
    def wrap(x):return (x+math.pi)%(2*math.pi)-math.pi
    rings=[]
    for layer in layers:
        ordered=sorted(layer,key=lambda i:angle(positions[i]))
        shift=min(range(26),key=lambda s:sum(wrap(angle(positions[ordered[(k+s)%26]])-angle(controls[root[k]]['sourcePosition']))**2 for k in range(26)))
        ring=[0]*26
        for k,column in enumerate(root):ring[column]=ordered[(k+shift)%26]
        rings.append(ring)
    targets=[];tangent_scale=data.get('tangentScale',1.0)
    for column,control in enumerate(controls):
        start=control['position'];end=positions[rings[10][column]];following=positions[rings[11][column]]
        chord=[b-a for a,b in zip(start,end)];length=math.sqrt(sum(v*v for v in chord))
        direction=[b-a for a,b in zip(end,following)];norm=math.sqrt(sum(v*v for v in direction))
        require(norm>1e-8 and length>1e-8,'Invalid collar tangent')
        tangent=[v/norm*length*tangent_scale for v in direction]
        for row in range(11):
            t=row/10;h00=2*t**3-3*t*t+1;h10=t**3-2*t*t+t;h01=-2*t**3+3*t*t;h11=t**3-t*t
            target=[round(h00*start[k]+h10*chord[k]+h01*end[k]+h11*tangent[k],8) for k in range(3)]
            if row == 10: target=list(end)  # Preserve the body join bit-for-bit.
            vertex=rings[row][column]
            targets.append({'sourceVertex':vertex,'sourcePosition':list(positions[vertex]),'position':target,'row':row,'column':column})
    targets.sort(key=lambda r:(r['row'],r['column']))
    maximum=max(math.dist(r['sourcePosition'],r['position']) for r in targets)
    require(maximum<=data['maximumAuthoredDisplacementMetres'],'Authored source bound exceeded')
    data={**data,'surfaceControls':targets,'construction':{'rows':11,'columns':26,'topology':'Existing source indices/UVs/weights retained; continuous Hermite neutral strip; no added posed fairing passes','fixedBodyRow':10,'bodyTangentRow':11,'maximumDisplacementMetres':maximum}}
    return data

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--write',action='store_true');p.add_argument('--check',action='store_true');args=p.parse_args()
    before=json.loads(DATA.read_text());after=rebuild(before)
    encoded=json.dumps(after,indent=2)+'\n'
    if args.write:DATA.write_text(encoded)
    if args.check:require(DATA.read_text()==encoded,'Collar source export differs')
    print(json.dumps({'sourceSHA256':after['source']['sha256'],'controlMeshSHA256':hashlib.sha256(encoded.encode()).hexdigest(),'surfaceControlCount':len(after['surfaceControls']),**after['construction']},indent=2))
if __name__=='__main__':main()
