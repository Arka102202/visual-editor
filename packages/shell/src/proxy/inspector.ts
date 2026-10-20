// The inspector: a small script the proxy adds to every page of the app, before the app's own code. It runs in the
// page (plain browser JavaScript, served at /__ve/inspector.js):
//   - calls to other addresses (a backend at http://localhost:8080) go through the proxy instead (/__ve/x/…), so they
//     are seen (and, later, faked) too; the page's own calls are marked, so the proxy tells them from files;
//   - it says hello to the window around it (Visual Editor's Preview), and tells it everything the page logs (the
//     console, uncaught errors, failed promises), with where each was logged from.

/** Where the proxy serves its own files, and sends calls meant for other addresses. */
export const VE_PATH = '/__ve';
/** The header that marks a call the page made (fetch or XHR), as opposed to a file the browser loads. */
export const CALL_HEADER = 'x-ve-call';

/** The console, told to the Preview: every message (values copied safely), with where it was logged from. */
const CONSOLE = String.raw`(() => {
  var ve = window.__veInspector;
  if (!ve || ve.console) return;
  ve.console = true;
  var queue = [];
  var timer = 0;
  function flush() { timer = 0; if (queue.length) ve.say({ type: 'console', entries: queue.splice(0) }); }
  function push(e) { queue.push(e); if (!timer) timer = setTimeout(flush, 40); }
  /** A value as something that can be posted: plain values as they are, objects up to a depth, the rest described. */
  function copy(v, depth, seen) {
    var t = typeof v;
    if (v === null || t === 'string' || t === 'number' || t === 'boolean') return v;
    if (t === 'undefined') return { $t: 'undefined' };
    if (t === 'bigint') return { $t: 'bigint', text: String(v) + 'n' };
    if (t === 'symbol') return { $t: 'symbol', text: String(v) };
    if (t === 'function') return { $t: 'function', text: 'ƒ ' + (v.name || 'anonymous') + '()' };
    if (v instanceof Error) return { $t: 'error', text: v.name + ': ' + v.message, stack: String(v.stack || '') };
    if (typeof Element !== 'undefined' && v instanceof Element) return { $t: 'element', text: '<' + v.tagName.toLowerCase() + (v.id ? '#' + v.id : '') + (typeof v.className === 'string' && v.className ? '.' + v.className.trim().split(/\s+/).join('.') : '') + '>' };
    if (seen.indexOf(v) >= 0) return { $t: 'circular', text: '[circular]' };
    if (depth > 4) return { $t: 'more', text: Array.isArray(v) ? 'Array(' + v.length + ')' : '{…}' };
    seen = seen.concat([v]);
    if (Array.isArray(v)) {
      var list = [];
      for (var i = 0; i < v.length && i < 100; i++) list.push(copy(v[i], depth + 1, seen));
      if (v.length > 100) list.push({ $t: 'more', text: '… ' + (v.length - 100) + ' more' });
      return list;
    }
    if (v instanceof Map) return { $t: 'map', size: v.size, entries: Array.from(v.entries()).slice(0, 50).map(function (e) { return [copy(e[0], depth + 1, seen), copy(e[1], depth + 1, seen)]; }) };
    if (v instanceof Set) return { $t: 'set', size: v.size, items: Array.from(v).slice(0, 50).map(function (x) { return copy(x, depth + 1, seen); }) };
    if (v instanceof Date) return { $t: 'date', text: v.toISOString() };
    var out = {};
    var keys = Object.keys(v);
    for (var k = 0; k < keys.length && k < 100; k++) {
      try { out[keys[k]] = copy(v[keys[k]], depth + 1, seen); } catch (e) { out[keys[k]] = { $t: 'error', text: '(could not read)' }; }
    }
    var name = v.constructor && v.constructor.name;
    return name && name !== 'Object' ? { $t: 'object', name: name, fields: out } : out;
  }
  /** Where the call came from: the first place in the stack outside this inspector. */
  function caller(stack) {
    var lines = String(stack || '').split('\n');
    for (var i = 1; i < lines.length; i++) {
      var m = /\(?((?:https?|blob):[^\s)]+):(\d+):(\d+)\)?\s*$/.exec(lines[i]);
      if (m && m[1].indexOf('/__ve/') < 0) return { url: m[1], line: Number(m[2]), column: Number(m[3]) };
    }
    return undefined;
  }
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var real = console[level];
    console[level] = function () {
      try {
        var args = Array.prototype.slice.call(arguments);
        push({ level: level, args: args.map(function (a) { return copy(a, 0, []); }), at: caller(new Error().stack), time: Date.now() });
      } catch (e) {}
      return real.apply(console, arguments);
    };
  });
  window.addEventListener('error', function (e) {
    push({ level: 'error', uncaught: true, args: [e.error ? copy(e.error, 0, []) : String(e.message)], at: e.filename ? { url: e.filename, line: e.lineno, column: e.colno } : caller(e.error && e.error.stack), time: Date.now() });
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    push({ level: 'error', uncaught: true, promise: true, args: [copy(r, 0, [])], at: caller(r && r.stack), time: Date.now() });
  });
})();
`;

export const INSPECTOR = `(() => {
  if (window.__veInspector) return;
  window.__veInspector = { version: 1 };
  var here = location.origin;
  /** A call to another address goes through the proxy: /__ve/x/<origin>/<path>. */
  function route(url) {
    try {
      var u = new URL(url, location.href);
      if (u.origin === here || !/^https?:$/.test(u.protocol)) return null;
      return here + '${VE_PATH}/x/' + encodeURIComponent(u.origin) + u.pathname + u.search;
    } catch (e) {
      return null;
    }
  }
  var realFetch = window.fetch;
  window.fetch = function (input, init) {
    var isRequest = typeof Request !== 'undefined' && input instanceof Request;
    var url = isRequest ? input.url : String(input instanceof URL ? input.href : input);
    var to = route(url);
    var request = new Request(to || url, isRequest ? input : init);
    if (isRequest && init) request = new Request(request, init);
    request.headers.set('${CALL_HEADER}', '1');
    return realFetch.call(window, request);
  };
  var open = XMLHttpRequest.prototype.open;
  var send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    var to = route(String(url));
    if (to) args[1] = to;
    return open.apply(this, args);
  };
  XMLHttpRequest.prototype.send = function () {
    try { this.setRequestHeader('${CALL_HEADER}', '1'); } catch (e) {}
    return send.apply(this, arguments);
  };
  /** Messages to the window around the page (Visual Editor's Preview), when there is one. */
  window.__veInspector.say = function (m) {
    if (window.parent !== window) window.parent.postMessage(Object.assign({ source: 've-inspector' }, m), '*');
  };
  window.__veInspector.say({ type: 'hello', url: location.href });
  // The address as the app changes it (its router), for the Preview's address bar.
  function where() { window.__veInspector.say({ type: 'location', url: location.href }); }
  ['pushState', 'replaceState'].forEach(function (k) {
    var real = history[k];
    history[k] = function () { var r = real.apply(this, arguments); where(); return r; };
  });
  window.addEventListener('popstate', where);
  window.addEventListener('hashchange', where);
  // Back, forward and reload, asked by the Preview around the page.
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (e.source !== window.parent || !m || m.source !== 've-preview') return;
    if (m.type === 'go') history.go(m.steps);
    if (m.type === 'reload') location.reload();
  });
})();
` + CONSOLE;
