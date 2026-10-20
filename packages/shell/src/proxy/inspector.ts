// The inspector: a small script the proxy adds to every page of the app, before the app's own code. It runs in the
// page (plain browser JavaScript, served at /__ve/inspector.js):
//   - calls to other addresses (a backend at http://localhost:8080) go through the proxy instead (/__ve/x/…), so they
//     are seen (and, later, faked) too; the page's own calls are marked, so the proxy tells them from files;
//   - it says hello to the window around it (Visual Editor's Preview), which later steps talk to (console, CSS, app).

/** Where the proxy serves its own files, and sends calls meant for other addresses. */
export const VE_PATH = '/__ve';
/** The header that marks a call the page made (fetch or XHR), as opposed to a file the browser loads. */
export const CALL_HEADER = 'x-ve-call';

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
})();
`;
