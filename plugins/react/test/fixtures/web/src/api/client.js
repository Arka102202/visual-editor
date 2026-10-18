export const api = {
  getOrders: () => fetch('/api/orders').then((r) => r.json()),
  cancelOrder: (id) => fetch(`/api/orders/${id}`, { method: 'DELETE' }),
}
