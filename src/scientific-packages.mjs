const numbers = (values) => {
  if (!Array.isArray(values) || values.length > 1200 || !values.every(Number.isFinite))
    throw Error('Expected finite numeric array');
  return values;
};
const nonempty = (v) => {
  numbers(v);
  if (!v.length) throw Error('Empty sample');
  return v;
};
const mean = (v) => nonempty(v).reduce((s, x) => s + x, 0) / v.length;
const sd = (v, ddof = 0) => {
  const m = mean(v);
  if (v.length <= ddof) throw Error('Insufficient sample');
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - ddof));
};
const median = (v) => {
  const xs = nonempty(v)
      .slice()
      .sort((a, b) => a - b),
    i = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[i] : (xs[i - 1] + xs[i]) / 2;
};
const vectors = new WeakSet();
const vector = (v) => {
  numbers(v);
  vectors.add(v);
  return v;
};
export const isVector = (v) => vectors.has(v);
export const vec = (a, b, fn) => {
  if (!Array.isArray(a)) {
    if (!Number.isFinite(a) || !Array.isArray(b)) throw Error('Expected array operand');
    return vector(numbers(b).map((v) => fn(a, v)));
  }
  numbers(a);
  if (Array.isArray(b)) {
    numbers(b);
    if (b.length !== a.length) throw Error('Array shape mismatch');
  } else if (!Number.isFinite(b)) throw Error('Expected scalar');
  return vector(a.map((v, i) => fn(v, Array.isArray(b) ? b[i] : b)));
};
export const packages = Object.freeze({
  math: {
    sqrt: Math.sqrt,
    log: Math.log,
    exp: Math.exp,
    fabs: Math.abs,
    floor: Math.floor,
    ceil: Math.ceil,
    isfinite: Number.isFinite
  },
  statistics: { mean, median, pstdev: sd, stdev: (v) => sd(v, 1) },
  numpy: {
    array: (v) => vector(numbers(v).slice()),
    asarray: (v) => vector(numbers(v).slice()),
    mean,
    median,
    std: sd,
    min: (v) => Math.min(...nonempty(v)),
    max: (v) => Math.max(...nonempty(v)),
    sum: (v) => numbers(v).reduce((s, x) => s + x, 0),
    diff: (v) =>
      vector(
        numbers(v)
          .slice(1)
          .map((x, i) => x - v[i])
      ),
    cumsum: (v) => {
      let sum = 0;
      return vector(numbers(v).map((x) => (sum += x)));
    },
    multiply: (a, b) => vec(a, b, (x, y) => x * y),
    add: (a, b) => vec(a, b, (x, y) => x + y),
    subtract: (a, b) => vec(a, b, (x, y) => x - y),
    divide: (a, b) => vec(a, b, (x, y) => x / y)
  }
});
export const packageInventory = Object.fromEntries(
  Object.entries(packages).map(([name, functions]) => [
    name,
    { version: 'desk-subset/1', functions: Object.keys(functions) }
  ])
);
