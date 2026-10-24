package tiles

import "math"

const (
	Extent  = 4096
	Buffer  = 64
	MinZoom = 9
	MaxZoom = 14
	Layer   = "ruas"
)

type Point struct{ X, Y float64 }

type Line struct {
	Points []Point
	Class  string
	OneWay bool
}

type Key struct{ Z, X, Y int }

func world(lon, lat float64, z int) Point {
	size := float64(Extent) * math.Exp2(float64(z))
	sin := math.Sin(lat * math.Pi / 180)
	return Point{
		X: (lon + 180) / 360 * size,
		Y: (0.5 - math.Log((1+sin)/(1-sin))/(4*math.Pi)) * size,
	}
}

func TileOf(lon, lat float64, z int) Key {
	p := world(lon, lat, z)
	return Key{Z: z, X: int(p.X / Extent), Y: int(p.Y / Extent)}
}

type encoder struct{ buf []byte }

func (e *encoder) varint(v uint64) {
	for v >= 0x80 {
		e.buf = append(e.buf, byte(v)|0x80)
		v >>= 7
	}
	e.buf = append(e.buf, byte(v))
}

func (e *encoder) key(field, wire int) { e.varint(uint64(field<<3 | wire)) }

func (e *encoder) uint(field int, v uint64) {
	e.key(field, 0)
	e.varint(v)
}

func (e *encoder) bytes(field int, b []byte) {
	e.key(field, 2)
	e.varint(uint64(len(b)))
	e.buf = append(e.buf, b...)
}

func (e *encoder) packed(field int, values []uint32) {
	var inner encoder
	for _, v := range values {
		inner.varint(uint64(v))
	}
	e.bytes(field, inner.buf)
}

func zigzag(v int32) uint32 { return uint32((v << 1) ^ (v >> 31)) }

func command(id, count int) uint32 { return uint32(id&0x7) | uint32(count)<<3 }

func geometry(parts [][][2]int32) []uint32 {
	var out []uint32
	var cx, cy int32
	for _, part := range parts {
		out = append(out, command(1, 1), zigzag(part[0][0]-cx), zigzag(part[0][1]-cy))
		cx, cy = part[0][0], part[0][1]
		out = append(out, command(2, len(part)-1))
		for _, p := range part[1:] {
			out = append(out, zigzag(p[0]-cx), zigzag(p[1]-cy))
			cx, cy = p[0], p[1]
		}
	}
	return out
}

type feature struct {
	tags  []uint32
	parts [][][2]int32
}

func encode(features []feature, keys []string, values []value) []byte {
	if len(features) == 0 {
		return nil
	}
	var layer encoder
	layer.uint(15, 2)
	layer.bytes(1, []byte(Layer))
	for i, f := range features {
		var fe encoder
		fe.uint(1, uint64(i+1))
		fe.packed(2, f.tags)
		fe.uint(3, 2)
		fe.packed(4, geometry(f.parts))
		layer.bytes(2, fe.buf)
	}
	for _, k := range keys {
		layer.bytes(3, []byte(k))
	}
	for _, v := range values {
		var ve encoder
		if v.isBool {
			b := uint64(0)
			if v.b {
				b = 1
			}
			ve.uint(7, b)
		} else {
			ve.bytes(1, []byte(v.s))
		}
		layer.bytes(4, ve.buf)
	}
	layer.uint(5, Extent)
	var tile encoder
	tile.bytes(3, layer.buf)
	return tile.buf
}

type value struct {
	s      string
	b      bool
	isBool bool
}

func Simplify(points []Point, tolerance float64) []Point {
	if len(points) < 3 {
		return points
	}
	keep := make([]bool, len(points))
	keep[0], keep[len(points)-1] = true, true
	var walk func(lo, hi int)
	walk = func(lo, hi int) {
		if hi-lo < 2 {
			return
		}
		a, b := points[lo], points[hi]
		dx, dy := b.X-a.X, b.Y-a.Y
		norm := math.Hypot(dx, dy)
		far, at := -1.0, -1
		for i := lo + 1; i < hi; i++ {
			p := points[i]
			var d float64
			if norm == 0 {
				d = math.Hypot(p.X-a.X, p.Y-a.Y)
			} else {
				d = math.Abs(dy*p.X-dx*p.Y+b.X*a.Y-b.Y*a.X) / norm
			}
			if d > far {
				far, at = d, i
			}
		}
		if far > tolerance {
			keep[at] = true
			walk(lo, at)
			walk(at, hi)
		}
	}
	walk(0, len(points)-1)
	out := make([]Point, 0, len(points))
	for i, k := range keep {
		if k {
			out = append(out, points[i])
		}
	}
	return out
}

func clipSegment(a, b Point, min, max float64) (Point, Point, bool) {
	t0, t1 := 0.0, 1.0
	dx, dy := b.X-a.X, b.Y-a.Y
	for _, edge := range [4][2]float64{{-dx, a.X - min}, {dx, max - a.X}, {-dy, a.Y - min}, {dy, max - a.Y}} {
		p, q := edge[0], edge[1]
		if p == 0 {
			if q < 0 {
				return a, b, false
			}
			continue
		}
		r := q / p
		if p < 0 {
			if r > t1 {
				return a, b, false
			}
			t0 = math.Max(t0, r)
		} else {
			if r < t0 {
				return a, b, false
			}
			t1 = math.Min(t1, r)
		}
	}
	return Point{a.X + t0*dx, a.Y + t0*dy}, Point{a.X + t1*dx, a.Y + t1*dy}, true
}

func Clip(points []Point, min, max float64) [][]Point {
	var parts [][]Point
	var current []Point
	for i := 1; i < len(points); i++ {
		a, b, ok := clipSegment(points[i-1], points[i], min, max)
		if !ok {
			if len(current) > 1 {
				parts = append(parts, current)
			}
			current = nil
			continue
		}
		if len(current) == 0 || current[len(current)-1] != a {
			if len(current) > 1 {
				parts = append(parts, current)
			}
			current = []Point{a}
		}
		current = append(current, b)
		if b != points[i] {
			parts = append(parts, current)
			current = nil
		}
	}
	if len(current) > 1 {
		parts = append(parts, current)
	}
	return parts
}

func quantize(parts [][]Point) [][][2]int32 {
	var out [][][2]int32
	for _, part := range parts {
		var q [][2]int32
		for _, p := range part {
			v := [2]int32{int32(math.Round(p.X)), int32(math.Round(p.Y))}
			if len(q) == 0 || q[len(q)-1] != v {
				q = append(q, v)
			}
		}
		if len(q) > 1 {
			out = append(out, q)
		}
	}
	return out
}
