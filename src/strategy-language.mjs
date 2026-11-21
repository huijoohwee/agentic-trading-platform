// Imports resolve only to the sealed offline scientific inventory.
import { packages, isVector, vec } from './scientific-packages.mjs';
const namePattern = /^[A-Za-z][A-Za-z0-9_]*$/;
const precedence = {
  or: 1,
  and: 2,
  '==': 3,
  '!=': 3,
  '>': 3,
  '<': 3,
  '>=': 3,
  '<=': 3,
  is: 3,
  '+': 4,
  '-': 4,
  '*': 5,
  '/': 5,
  '%': 5
};
const fail = (message) => {
  throw Error(message);
};
function expression(tokens) {
  let at = 0;
  const take = (s) => tokens[at] === s && (at++, true);
  const need = (s) => {
    if (!take(s)) fail('Expected ' + s);
  };
  const name = () => {
    const n = tokens[at++];
    if (!namePattern.test(n ?? '')) fail('Expected a name');
    return n;
  };
  function args(end) {
    const items = [];
    if (take(end)) return items;
    do {
      items.push(parse());
    } while (take(',') && tokens[at] !== end);
    need(end);
    return items;
  }
  function primary() {
    let node;
    if (take('(')) {
      node = parse();
      need(')');
    } else if (take('[')) {
      if (take(']')) return { kind: 'list', items: [] };
      const first = parse();
      if (take('for')) {
        const variable = name();
        need('in');
        const sequence = parse();
        node = { kind: 'comprehension', first, variable, sequence };
      } else {
        const items = [first];
        while (take(',') && tokens[at] !== ']') items.push(parse());
        node = { kind: 'list', items };
      }
      need(']');
    } else if (take('{')) {
      const pairs = [];
      if (!take('}')) {
        do {
          const key = parse();
          need(':');
          pairs.push([key, parse()]);
        } while (take(',') && tokens[at] !== '}');
        need('}');
      }
      node = { kind: 'dictionary', pairs };
    } else if (take('-')) node = { kind: 'unary', op: '-', arg: parse(6) };
    else if (take('not')) node = { kind: 'unary', op: 'not', arg: parse(3) };
    else {
      const t = tokens[at++];
      if (t === undefined) fail('Expected expression');
      if (/^\d/.test(t)) node = { kind: 'value', value: Number(t) };
      else if (/^["']/.test(t)) node = { kind: 'value', value: t.slice(1, -1).replace(/\\([\\"'])/g, '$1') };
      else if (['True', 'False', 'None'].includes(t))
        node = { kind: 'value', value: t === 'None' ? null : t === 'True' };
      else if (namePattern.test(t)) {
        const callable = take('.') ? t + '.' + name() : t;
        node = take('(') ? { kind: 'call', name: callable, args: args(')') } : { kind: 'variable', name: callable };
      } else fail('Unexpected ' + t);
    }
    while (take('[')) {
      const key = parse();
      need(']');
      node = { kind: 'index', base: node, key };
    }
    return node;
  }
  function parse(min = 0) {
    let left = primary();
    while (Object.hasOwn(precedence, tokens[at]) && precedence[tokens[at]] >= min) {
      const op = tokens[at++],
        negated = op === 'is' && take('not');
      left = { kind: 'binary', op: negated ? 'is not' : op, left, right: parse(precedence[op] + 1) };
    }
    return left;
  }
  const result = parse();
  if (at !== tokens.length) fail('Unexpected ' + tokens[at]);
  return result;
}
export function compileStrategy(code) {
  if (typeof code !== 'string' || code.length > 8192) fail('Source exceeds 8192 characters');
  const rows = [];
  let open = 0;
  for (const [i, line] of code.split('\n').entries()) {
    if (/^\s*\t/.test(line)) fail('Use spaces for indentation');
    const ts =
      line
        .trim()
        .match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|#.*$|\d+(?:\.\d+)?|[a-zA-Z_]\w*|!=|==|<=|>=|\+=|-=|\S/g)
        ?.filter((t) => !t.startsWith('#')) ?? [];
    if (!ts.length) continue;
    if (open) {
      rows.at(-1).ts.push(...ts);
    } else rows.push({ line: i + 1, indent: line.length - line.trimStart().length, ts });
    open +=
      ts.filter((t) => ['(', '[', '{'].includes(t)).length - ts.filter((t) => [')', ']', '}'].includes(t)).length;
    if (open < 0 || open > 24 || rows.at(-1).ts.length > 400) fail('Invalid expression bounds at line ' + (i + 1));
  }
  if (open || rows.length > 250) fail('Invalid module bounds');
  const defs = new Map(),
    imports = new Map();
  let def;
  for (const row of rows) {
    if (!row.indent) {
      const [keyword, mod, ...rest] = row.ts;
      if (keyword === 'import' || keyword === 'from') {
        if (!Object.hasOwn(packages, mod)) fail('Unavailable offline module');
        const member = keyword === 'from' ? rest[1] : null;
        const alias = member ? (rest[3] ?? member) : (rest[1] ?? mod);
        const valid = member
          ? rest[0] === 'import' &&
            Object.hasOwn(packages[mod], member) &&
            (rest.length === 2 || (rest.length === 4 && rest[2] === 'as'))
          : !rest.length || (rest.length === 2 && rest[0] === 'as');
        if (!valid || !namePattern.test(alias) || imports.has(alias)) fail('Invalid offline import');
        imports.set(alias, { mod, member });
        def = null;
        continue;
      }
      if (
        keyword !== 'def' ||
        !namePattern.test(mod) ||
        defs.has(mod) ||
        row.ts[2] !== '(' ||
        row.ts.at(-2) !== ')' ||
        row.ts.at(-1) !== ':'
      )
        fail('Expected named function');
      const args = row.ts.slice(3, -2);
      if (
        args.length &&
        (!args.every((v, i) => (i % 2 ? v === ',' : namePattern.test(v))) || args.length % 2 !== 1)
      )
        fail('Invalid arguments');
      const params = args.filter((_, i) => i % 2 === 0);
      if (new Set(params).size !== params.length) fail('Duplicate argument');
      def = { params, rows: [] };
      defs.set(mod, def);
    } else {
      if (!def) fail('Expected function');
      def.rows.push(row);
    }
  }
  if (defs.get('strategy')?.params.join(',') !== 'candles') fail('Define strategy(candles)');
  for (const fn of defs.values()) {
    if (!fn.rows.length) fail('Empty function');
    fn.body = parseBody(fn.rows);
    delete fn.rows;
  }
  return { defs, imports };
}
function parseBody(rows) {
  const stack = [{ indent: 0, body: [] }];
  let parent = { body: stack[0].body },
    prev = 0;
  for (const { line, indent, ts } of rows) {
    try {
      if (indent <= 0) fail('Expected function body');
      if (indent > prev) {
        if (!parent?.body) fail('Unexpected indentation');
        stack.push({ indent, body: parent.body });
      } else {
        if (parent?.body && !parent.body.length) fail('Empty block');
        while (stack.at(-1).indent > indent) stack.pop();
        if (stack.at(-1).indent !== indent) fail('Inconsistent indentation');
      }
      const stmts = stack.at(-1).body,
        first = ts[0];
      let s;
      if (['if', 'elif', 'else', 'for'].includes(first)) {
        if (ts.at(-1) !== ':') fail('Expected colon');
        if (first === 'for') {
          if (ts[2] !== 'in' || !namePattern.test(ts[1])) fail('Expected for name in sequence');
          s = { kind: 'for', name: ts[1], expr: expression(ts.slice(3, -1)), body: [] };
        } else {
          if (first === 'else' && ts.length !== 2) fail('Unexpected else expression');
          if (first !== 'if' && !['if', 'elif'].includes(stmts.at(-1)?.kind)) fail('Unexpected ' + first);
          s = { kind: first, expr: first === 'else' ? null : expression(ts.slice(1, -1)), body: [] };
        }
      } else if (first === 'return') s = { kind: 'return', expr: expression(ts.slice(1)) };
      else if (ts.length === 1 && ['continue', 'break', 'pass'].includes(first)) s = { kind: first };
      else if (namePattern.test(first) && ['=', '+=', '-='].includes(ts[1]))
        s = { kind: 'assign', name: first, mode: ts[1], expr: expression(ts.slice(2)) };
      else if (namePattern.test(first) && ts[1] === '.' && ts[2] === 'append' && ts[3] === '(' && ts.at(-1) === ')')
        s = { kind: 'append', name: first, expr: expression(ts.slice(4, -1)) };
      else s = { kind: 'expression', expr: expression(ts) };
      s.line = line;
      stmts.push(s);
      parent = s;
      prev = indent;
    } catch (e) {
      throw Error('Line ' + line + ': ' + e.message);
    }
  }
  if (parent?.body && !parent.body.length) fail('Empty block');
  return stack[0].body;
}
const binary = {
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  is: (a, b) => a === b,
  'is not': (a, b) => a !== b,
  '>': (a, b) => a > b,
  '<': (a, b) => a < b,
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => (b ? a / b : fail('Division by zero')),
  '%': (a, b) => (b ? a % b : fail('Division by zero'))
};
const truth = (v) => (Array.isArray(v) ? v.length !== 0 : Boolean(v));
export function runStrategy(program, candles, functions) {
  let vars = new Map([['candles', candles]]),
    depth = 0;
  const imported = Object.create(null);
  for (const [alias, { mod, member }] of program.imports) {
    if (member) imported[alias] = packages[mod][member];
    else for (const [key, fn] of Object.entries(packages[mod])) imported[alias + '.' + key] = fn;
  }
  let budget = 300000,
    line = 0;
  function sequence(v) {
    if (!Array.isArray(v) || v.length > 1200) fail('Expected a bounded list');
    return v;
  }
  function variable(n) {
    if (!vars.has(n)) fail('Unknown name ' + n);
    return vars.get(n);
  }
  function evaluate(n) {
    if (--budget < 0) fail('Instruction limit reached');
    switch (n.kind) {
      case 'variable':
        return variable(n.name);
      case 'value':
        return n.value;
      case 'list':
        return n.items.map(evaluate);
      case 'dictionary':
        return new Map(n.pairs.map(([k, v]) => [evaluate(k), evaluate(v)]));
      case 'index':
        {
          const v = evaluate(n.base),
            k = evaluate(n.key);
          if (v instanceof Map && v.has(k)) return v.get(k);
          if (Array.isArray(v) && Number.isInteger(k) && k >= -v.length && k < v.length) return v.at(k);
          fail('Unknown index or key');
        }
        break;
      case 'comprehension': {
        const seq = sequence(evaluate(n.sequence)),
          previous = vars.get(n.variable),
          existed = vars.has(n.variable);
        const result = seq.map((v) => {
          vars.set(n.variable, v);
          return evaluate(n.first);
        });
        if (existed) vars.set(n.variable, previous);
        else vars.delete(n.variable);
        return result;
      }
      case 'call': {
        const args = n.args.map(evaluate),
          fn = program.defs.get(n.name);
        if (fn) {
          if (args.length !== fn.params.length || depth >= 24) fail('Function call limit or invalid arguments');
          const parent = vars;
          vars = new Map(fn.params.map((p, i) => [p, args[i]]));
          depth++;
          try {
            return block(fn.body)?.value ?? null;
          } finally {
            vars = parent;
            depth--;
          }
        }
        if (Object.hasOwn(imported, n.name)) return imported[n.name](...args);
        if (!Object.hasOwn(functions, n.name)) fail('Unsupported helper ' + n.name);
        return functions[n.name](...args);
      }
      case 'unary': {
        const v = evaluate(n.arg);
        if (n.op === 'not') return !truth(v);
        if (isVector(v)) return vec(v, -1, (a, b) => a * b);
        if (!Number.isFinite(v)) fail('Expected number');
        return -v;
      }
      case 'binary': {
        const a = evaluate(n.left);
        if (n.op === 'and') return truth(a) ? evaluate(n.right) : a;
        if (n.op === 'or') return truth(a) ? a : evaluate(n.right);
        const b = evaluate(n.right);
        if ((isVector(a) || isVector(b)) && ['+', '-', '*', '/', '%'].includes(n.op))
          return vec(a, b, binary[n.op]);
        if (!['==', '!=', 'is', 'is not'].includes(n.op) && ![a, b].every(Number.isFinite))
          fail('Expected finite numbers');
        const out = binary[n.op](a, b);
        if (typeof out === 'number' && !Number.isFinite(out)) fail('Numeric overflow');
        return out;
      }
    }
  }
  function block(stmts) {
    let matched = false;
    for (const s of stmts) {
      line = s.line;
      if (--budget < 0) fail('Instruction limit reached');
      switch (s.kind) {
        case 'if':
        case 'elif':
        case 'else': {
          if (s.kind === 'if') matched = false;
          if (!matched && (s.kind === 'else' || truth(evaluate(s.expr)))) {
            matched = true;
            const flow = block(s.body);
            if (flow) return flow;
          }
          break;
        }
        case 'for':
          for (const v of sequence(evaluate(s.expr))) {
            vars.set(s.name, v);
            const flow = block(s.body);
            if (flow?.kind === 'return') return flow;
            if (flow?.kind === 'break') break;
          }
          break;
        case 'assign': {
          const val = evaluate(s.expr);
          if (s.mode === '=') vars.set(s.name, val);
          else {
            const old = variable(s.name);
            if (![old, val].every(Number.isFinite)) fail('Expected numbers');
            vars.set(s.name, s.mode === '+=' ? old + val : old - val);
          }
          break;
        }
        case 'append': {
          const list = sequence(variable(s.name));
          if (list.length >= 1200) fail('List limit reached');
          list.push(evaluate(s.expr));
          break;
        }
        case 'return':
          return { kind: 'return', value: evaluate(s.expr) };
        case 'continue':
        case 'break':
          return s;
        case 'expression':
          evaluate(s.expr);
          break;
      }
    }
  }
  try {
    const result = block(program.defs.get('strategy').body);
    if (result?.kind !== 'return') fail('Return a signal list');
    return sequence(result.value);
  } catch (e) {
    throw Error('Line ' + line + ': ' + e.message);
  }
}
