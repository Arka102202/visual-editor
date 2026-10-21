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
  function copy(v, depth, seen, o) {
    var t = typeof v;
    if (v === null || t === 'string' || t === 'number' || t === 'boolean') return v;
    if (o && o.replace && (t === 'object' || t === 'function')) { var r = o.replace(v); if (r !== undefined) return r; }
    if (t === 'undefined') return { $t: 'undefined' };
    if (t === 'bigint') return { $t: 'bigint', text: String(v) + 'n' };
    if (t === 'symbol') return { $t: 'symbol', text: String(v) };
    if (t === 'function') return { $t: 'function', text: 'ƒ ' + (v.name || 'anonymous') + '()' };
    if (v instanceof Error) return { $t: 'error', text: v.name + ': ' + v.message, stack: String(v.stack || '') };
    if (typeof Element !== 'undefined' && v instanceof Element) return { $t: 'element', text: '<' + v.tagName.toLowerCase() + (v.id ? '#' + v.id : '') + (typeof v.className === 'string' && v.className ? '.' + v.className.trim().split(/\s+/).join('.') : '') + '>' };
    if (seen.indexOf(v) >= 0) return { $t: 'circular', text: '[circular]' };
    if (depth > (o && o.depth !== undefined ? o.depth : 4)) return { $t: 'more', text: Array.isArray(v) ? 'Array(' + v.length + ')' : '{…}' };
    seen = seen.concat([v]);
    if (Array.isArray(v)) {
      var list = [];
      for (var i = 0; i < v.length && i < 100; i++) list.push(copy(v[i], depth + 1, seen, o));
      if (v.length > 100) list.push({ $t: 'more', text: '… ' + (v.length - 100) + ' more' });
      return list;
    }
    if (v instanceof Map) return { $t: 'map', size: v.size, entries: Array.from(v.entries()).slice(0, 50).map(function (e) { return [copy(e[0], depth + 1, seen, o), copy(e[1], depth + 1, seen, o)]; }) };
    if (v instanceof Set) return { $t: 'set', size: v.size, items: Array.from(v).slice(0, 50).map(function (x) { return copy(x, depth + 1, seen, o); }) };
    if (v instanceof Date) return { $t: 'date', text: v.toISOString() };
    var out = {};
    var keys = Object.keys(v);
    for (var k = 0; k < keys.length && k < 100; k++) {
      try { out[keys[k]] = copy(v[keys[k]], depth + 1, seen, o); } catch (e) { out[keys[k]] = { $t: 'error', text: '(could not read)' }; }
    }
    var name = v.constructor && v.constructor.name;
    return name && name !== 'Object' ? { $t: 'object', name: name, fields: out } : out;
  }
  ve.copy = function (v, options) { return copy(v, 0, [], options || {}); };
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

/**
 * The picker and an element's styles, told to the Preview: hovering outlines an element (margin and padding shaded,
 * its tag, classes and size shown); clicking selects it (the app doesn't get that click). For the selected element:
 * its path, box model, every rule that applies (with where it comes from: a stylesheet's file, or Tailwind), what's
 * overridden, and its final values.
 */
const PICKER = String.raw`(() => {
  var ve = window.__veInspector;
  if (!ve || ve.picker) return;
  ve.picker = true;
  var picking = false;
  var selected = null;
  var overlay = null;
  function px(v) { return parseFloat(v) || 0; }
  function layer(color) { var d = document.createElement('div'); d.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;box-sizing:border-box;' + color; return d; }
  function makeOverlay() {
    if (overlay) return overlay;
    overlay = { margin: layer('background:rgba(246,178,107,.35)'), border: layer('background:rgba(255,229,153,.35)'), padding: layer('background:rgba(147,196,125,.4)'), content: layer('background:rgba(111,168,220,.45)'), tag: layer('background:#1e1e1e;color:#fff;font:11px/1.6 ui-monospace,monospace;padding:1px 6px;border-radius:3px;white-space:nowrap;') };
    return overlay;
  }
  function place(d, x, y, w, h) { d.style.left = x + 'px'; d.style.top = y + 'px'; d.style.width = Math.max(0, w) + 'px'; d.style.height = Math.max(0, h) + 'px'; }
  function label(el) {
    var t = el.tagName.toLowerCase();
    if (el.id) t += '#' + el.id;
    if (typeof el.className === 'string' && el.className.trim()) t += '.' + el.className.trim().split(/\s+/).slice(0, 4).join('.');
    return t;
  }
  function show(el) {
    var o = makeOverlay();
    var parts = [o.margin, o.border, o.padding, o.content, o.tag];
    if (!el) { parts.forEach(function (p) { p.remove(); }); return; }
    parts.forEach(function (p) { if (!p.isConnected) document.documentElement.appendChild(p); });
    var r = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    var m = [px(cs.marginTop), px(cs.marginRight), px(cs.marginBottom), px(cs.marginLeft)];
    var b = [px(cs.borderTopWidth), px(cs.borderRightWidth), px(cs.borderBottomWidth), px(cs.borderLeftWidth)];
    var p = [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)];
    place(o.margin, r.left - m[3], r.top - m[0], r.width + m[1] + m[3], r.height + m[0] + m[2]);
    place(o.border, r.left, r.top, r.width, r.height);
    place(o.padding, r.left + b[3], r.top + b[0], r.width - b[1] - b[3], r.height - b[0] - b[2]);
    place(o.content, r.left + b[3] + p[3], r.top + b[0] + p[0], r.width - b[1] - b[3] - p[1] - p[3], r.height - b[0] - b[2] - p[0] - p[2]);
    o.tag.textContent = label(el) + '  ' + Math.round(r.width) + ' × ' + Math.round(r.height);
    o.tag.style.left = Math.max(0, r.left) + 'px';
    o.tag.style.top = (r.top > 24 ? r.top - 22 : r.bottom + 4) + 'px';
    o.tag.style.width = 'auto'; o.tag.style.height = 'auto';
  }
  function onMove(e) { if (picking) show(e.target); }
  function onClick(e) {
    if (!picking) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    picking = false;
    ve.say({ type: 'picking', on: false });
    select(e.target);
  }
  /** Plugins' page scripts hear of each pick (window.visualEditor.onPicked). */
  ve.picked = [];
  function swallow(e) { if (picking) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); } }
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('click', onClick, true);
  ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu'].forEach(function (t) { window.addEventListener(t, swallow, true); });
  window.addEventListener('keydown', function (e) { if (picking && e.key === 'Escape') { picking = false; show(null); ve.say({ type: 'picking', on: false }); } }, true);


  /** How strong a selector is: [ids, classes and the like, tags]. */
  function specificity(sel) {
    var s = sel.replace(/::?(not|is|where|has)\(([^()]*)\)/g, function (m, k, inner) { return k === 'where' ? '' : ' ' + inner + ' '; });
    var ids = (s.match(/#[\w-]+/g) || []).length;
    var classes = (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) || []).length;
    var tags = (s.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|::?[\w-]+(\([^)]*\))?/g, ' ').match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length + (s.match(/::[\w-]+/g) || []).length;
    return [ids, classes, tags];
  }
  function stronger(a, b) { for (var i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; }
  /** "a: b; c: d !important" as declarations (shorthands as written). */
  function declarations(style) {
    var out = [];
    var text = style.cssText;
    var depth = 0, start = 0;
    for (var i = 0; i <= text.length; i++) {
      var ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if ((ch === ';' && depth === 0) || i === text.length) {
        var part = text.slice(start, i).trim();
        start = i + 1;
        var at = part.indexOf(':');
        if (at < 1) continue;
        var name = part.slice(0, at).trim();
        var value = part.slice(at + 1).trim();
        var important = /!important$/.test(value);
        out.push({ name: name, value: value.replace(/\s*!important$/, ''), important: important });
      }
    }
    return out;
  }
  function sourceOf(sheet) {
    var node = sheet.ownerNode;
    var id = node && node.getAttribute && (node.getAttribute('data-vite-dev-id') || node.getAttribute('data-href'));
    if (id) return id;
    if (sheet.href) return sheet.href;
    return node && node.tagName === 'STYLE' ? '<style> in the page' : '';
  }
  function rulesFor(el) {
    var found = [];
    var order = 0;
    function walk(rules, sheet, media) {
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        order++;
        if (r.type === 1 || r.selectorText) {
          var parts = String(r.selectorText).split(/,(?![^(]*\))/);
          var best = null;
          for (var k = 0; k < parts.length; k++) {
            try { if (el.matches(parts[k].trim())) { var sp = specificity(parts[k]); if (!best || stronger(sp, best.sp)) best = { sel: parts[k].trim(), sp: sp }; } } catch (e) {}
          }
          if (best) found.push({ selector: r.selectorText, matched: best.sel, specificity: best.sp, order: order, media: media.slice(), source: sourceOf(sheet), declarations: declarations(r.style) });
        } else if (r.media && r.cssRules) {
          var mt = r.media.mediaText;
          if (!mt || matchMedia(mt).matches) walk(r.cssRules, sheet, media.concat(['@media ' + mt]));
        } else if (r.conditionText !== undefined && r.cssRules && /supports/i.test(r.constructor.name)) {
          if (CSS.supports(r.conditionText)) walk(r.cssRules, sheet, media.concat(['@supports ' + r.conditionText]));
        } else if (r.cssRules) {
          walk(r.cssRules, sheet, r.name ? media.concat(['@layer ' + r.name]) : media);
        }
      }
    }
    for (var s = 0; s < document.styleSheets.length; s++) {
      var sheet = document.styleSheets[s];
      try { walk(sheet.cssRules, sheet, []); } catch (e) {}
    }
    // Strongest first: !important, then how strong the selector is, then which comes later.
    found.sort(function (a, b) { return stronger(b.specificity, a.specificity) ? 1 : stronger(a.specificity, b.specificity) ? -1 : b.order - a.order; });
    if (el.style && el.style.cssText) found.unshift({ selector: 'element.style', matched: 'style=""', specificity: [1, 0, 0, 0], order: Infinity, media: [], source: 'inline', declarations: declarations(el.style) });
    // What's overridden: a property set by a stronger rule (or an !important one) already.
    var won = {};
    found.forEach(function (rule) { rule.declarations.forEach(function (d) { if (d.important && !won[d.name + '!']) won[d.name + '!'] = rule; }); });
    found.forEach(function (rule) {
      rule.declarations.forEach(function (d) {
        var imp = won[d.name + '!'];
        if (imp && imp !== rule) { d.overridden = true; return; }
        if (!d.important) { if (won[d.name]) d.overridden = true; else won[d.name] = rule; }
      });
    });
    return found;
  }
  var COMPUTED = ['display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'box-sizing', 'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-style', 'border-color', 'border-radius', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-self', 'gap', 'flex-grow', 'flex-shrink', 'flex-basis', 'grid-template-columns', 'grid-template-rows', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align', 'text-transform', 'white-space', 'color', 'background-color', 'background-image', 'opacity', 'box-shadow', 'overflow', 'cursor', 'transform', 'transition'];
  function info(el) {
    var cs = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    var path = [];
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) path.unshift(label(n));
    var all = {};
    for (var i = 0; i < cs.length; i++) all[cs[i]] = cs.getPropertyValue(cs[i]);
    var key = {};
    COMPUTED.forEach(function (k) { key[k] = cs.getPropertyValue(k); });
    return {
      label: label(el),
      tag: el.tagName.toLowerCase(),
      classes: typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [],
      path: path,
      size: { width: r.width, height: r.height },
      box: {
        margin: [cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft].map(px),
        border: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(px),
        padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(px),
        content: { width: r.width - px(cs.paddingLeft) - px(cs.paddingRight) - px(cs.borderLeftWidth) - px(cs.borderRightWidth), height: r.height - px(cs.paddingTop) - px(cs.paddingBottom) - px(cs.borderTopWidth) - px(cs.borderBottomWidth) },
      },
      rules: withVariables(rulesFor(el), cs),
      computed: key,
      all: all,
      text: (el.textContent || '').trim().slice(0, 80),
    };
  }
  /** What each var(--x) in the rules stands for on this element. */
  function withVariables(rules, cs) {
    rules.forEach(function (rule) {
      rule.declarations.forEach(function (d) {
        var names = d.value.match(/--[\w-]+/g);
        if (!names) return;
        d.vars = {};
        names.forEach(function (n) { d.vars[n] = cs.getPropertyValue(n).trim(); });
      });
    });
    return rules;
  }
  /** Outlines only while picking (what's under the mouse); a pick flashes, then the outline goes. */
  var flash = 0;
  function select(el) {
    selected = el;
    show(el);
    clearTimeout(flash);
    flash = setTimeout(function () { if (!picking) show(null); }, 700);
    if (el) ve.say({ type: 'picked', element: info(el) });
    if (el) ve.picked.forEach(function (fn) { try { fn(el); } catch (err) { console.error(err); } });
  }
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (e.source !== window.parent || !m || m.source !== 've-preview') return;
    if (m.type === 'pick') { picking = !!m.on; if (!picking) show(null); }
    if (m.type === 'refresh' && selected) select(selected.isConnected ? selected : null);
    if (m.type === 'selectUp' && selected) { var t = selected; for (var i = 0; i < m.steps && t.parentElement; i++) t = t.parentElement; select(t); }
    if (m.type === 'unselect') { selected = null; show(null); }
  });
})();
`;

/** What plugins' page scripts get: window.visualEditor (the contract's PreviewPageApi). */
const PLUGINS = String.raw`(() => {
  var ve = window.__veInspector;
  if (!ve || window.visualEditor) return;
  var handlers = {};
  var outline = null;

  window.visualEditor = {
    version: 1,
    on: function (channel, fn) { (handlers[channel] = handlers[channel] || []).push(fn); },
    send: function (channel, data) { ve.say({ type: 'plugin', channel: channel, data: data }); },
    copy: function (v, options) { return ve.copy(v, options); },
    highlight: function (els, text) {
      if (outline) { outline.forEach(function (d) { d.remove(); }); outline = null; }
      if (!els || !els.length) return;
      outline = [];
      var all = null;
      els.slice(0, 50).forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (!r.width && !r.height) return;
        var d = box();
        d.style.left = r.left + 'px'; d.style.top = r.top + 'px'; d.style.width = r.width + 'px'; d.style.height = r.height + 'px';
        document.documentElement.appendChild(d);
        outline.push(d);
        all = all ? { l: Math.min(all.l, r.left), t: Math.min(all.t, r.top), b: Math.max(all.b, r.bottom) } : { l: r.left, t: r.top, b: r.bottom };
      });
      if (text && all) {
        var tag = document.createElement('div');
        tag.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;background:#4f8cff;color:#fff;font:11px/1.6 ui-monospace,monospace;padding:1px 6px;border-radius:3px;white-space:nowrap';
        tag.textContent = text;
        tag.style.left = Math.max(0, all.l) + 'px';
        tag.style.top = (all.t > 24 ? all.t - 22 : all.b + 4) + 'px';
        document.documentElement.appendChild(tag);
        outline.push(tag);
      }
    },
    onPicked: function (fn) { ve.picked.push(fn); },
  };
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (e.source !== window.parent || !m || m.source !== 've-preview') return;
    if (m.type !== 'plugin') return;
    (handlers[m.channel] || []).forEach(function (fn) { try { fn(m.data); } catch (err) { console.error(err); } });
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
  // Shown inside a frame (Preview in VS Code): the browser keeps only "SameSite=None; Secure" cookies there, so the
  // ones the app sets are made so (the proxy does the same for cookies its backend sets). Not in a browser of its own.
  var framed = window.parent !== window;
  if (framed) {
    var cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (cookie && cookie.set) {
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        get: function () { return cookie.get.call(document); },
        set: function (v) { cookie.set.call(document, String(v).replace(/;\\s*secure\\b/gi, '').replace(/;\\s*samesite=[^;]*/gi, '') + '; SameSite=None; Secure'); },
      });
    }
  }
  var realFetch = window.fetch;
  window.fetch = function (input, init) {
    var isRequest = typeof Request !== 'undefined' && input instanceof Request;
    var url = isRequest ? input.url : String(input instanceof URL ? input.href : input);
    var to = route(url);
    var request = new Request(to || url, isRequest ? input : init);
    if (isRequest && init) request = new Request(request, init);
    request.headers.set('${CALL_HEADER}', framed ? 'frame' : '1');
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
    try { this.setRequestHeader('${CALL_HEADER}', framed ? 'frame' : '1'); } catch (e) {}
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
` + CONSOLE + PICKER + PLUGINS;
