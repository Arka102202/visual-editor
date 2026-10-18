import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import { ProductPage } from '@/pages/ProductPage'
import Orders from '@/pages/Orders'
import { Cart } from './pages/Cart'
import Dashboard from './pages/Dashboard'
const Settings = lazy(() => import('./pages/Settings'))

const PATHS = { HOME: '/', PRODUCT: '/products/:id' }

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<p>Loading…</p>}>
        <Routes>
          <Route path={PATHS.HOME} element={<Home />} />
          <Route path={PATHS.PRODUCT} element={<ProductPage />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/account">
            <Route path="orders" element={<Orders />} />
            <Route path="cart" element={<Cart />} />
            <Route path="settings" element={<Settings />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}
