"""CPU-only regression tests for original reversible preferred-shirt tailoring."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('garment', Path(__file__).with_name('build-football-continuous-garment.py'))
garment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(garment)

class TailoringTests(unittest.TestCase):
    def test_source_topology_and_collar_binding_are_retained(self):
        points = [[-.07,1.48,-.05],[.07,1.48,-.05],[.23,1.49,0],[-.23,1.49,0]]
        original = [p[:] for p in points]
        weights = [[(1,.6),(2,.4)] for _ in points]
        names = ['chest','neck','head']
        polygons = [[[0,0],[1,1],[2,2],[3,3]]]
        capped,audit = garment.tailor_shirt(points,weights,polygons,names)
        self.assertEqual(len(points),len(original))
        self.assertEqual(polygons,[[[0,0],[1,1],[2,2],[3,3]]])
        self.assertTrue(audit['sourceCorrespondenceRetained'])
        for i in (0,1):
            self.assertEqual(capped[i][0][0],0)
            self.assertAlmostEqual(capped[i][1][0],1.)
        for source,point,delta in zip(original,points,audit['deltas']):
            for a,b,d in zip(source,point,delta): self.assertAlmostEqual(a+d,b)
        self.assertLess(points[2][1],original[2][1])
        for _,row in capped:
            self.assertAlmostEqual(sum(row),1.)
            self.assertTrue(all(w>=0 for w in row))

if __name__ == '__main__': unittest.main()
