// Addresses of faked endpoints: their file names, the pattern for an address that was seen, and whether an address
// fits a pattern. No Node or VS Code parts: the Network panel (in the page) uses them too.

/** A file name for an endpoint: get-api-orders-{id} for GET /api/orders/:id. */
export function endpointId(method: string, path: string, origin?: string): string {
  const host = origin ? `${new URL(origin).host.replace(/[^\w]+/g, '-')}-` : '';
  const slug = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/:(\w+)/g, '{$1}')
    .replace(/\*/g, 'all')
    .replace(/[^\w{}.-]+/g, '-')
    .replace(/-+/g, '-');
  return `${method.toLowerCase()}-${host}${slug || 'root'}`.slice(0, 120);
}

/** An address pattern for a call that was seen: numbers and ids in it become :id, :id2… */
export function patternFor(path: string): string {
  let n = 0;
  return path
    .split('?')[0]
    .split('/')
    .map((part) => (/^\d+$|^[0-9a-f]{8}-[0-9a-f-]{27,}$|^[0-9a-f]{20,}$/i.test(part) ? `:${n++ ? `id${n}` : 'id'}` : part))
    .join('/');
}

/** Whether an address (its path) fits a pattern. */
export function fits(pattern: string, path: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split('/')
      .map((part) => (part === '*' ? '.*' : part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/')}/?$`,
  );
  return re.test(path.split('?')[0]);
}
