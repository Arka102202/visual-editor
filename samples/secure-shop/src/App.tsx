import { Route, Routes } from 'react-router-dom'
import { RequireAuth } from '@/auth/RequireAuth'
import { Navbar } from '@/components/Navbar'
import { Account } from '@/pages/Account'
import { Admin } from '@/pages/Admin'
import { Catalog } from '@/pages/Catalog'
import { Home } from '@/pages/Home'
import { Invoice } from '@/pages/Invoice'
import { Legacy } from '@/pages/Legacy'
import { Login } from '@/pages/Login'
import { MagicLink } from '@/pages/MagicLink'
import { OrderDetail } from '@/pages/OrderDetail'
import { Orders } from '@/pages/Orders'
import { Profile } from '@/pages/Profile'
import { Reports } from '@/pages/Reports'

export function App() {
  return (
    <>
      <Navbar />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/login/code" element={<MagicLink />} />
        <Route path="/catalog" element={<Catalog />} />
        <Route path="/profile" element={<Profile />} />
        {/* B12: everything below needs a login (route-level guard) */}
        <Route path="/orders" element={<RequireAuth><Orders /></RequireAuth>} />
        <Route path="/orders/:orderId" element={<RequireAuth><OrderDetail /></RequireAuth>} />
        <Route path="/admin" element={<RequireAuth><Admin /></RequireAuth>} />
        <Route path="/reports" element={<RequireAuth><Reports /></RequireAuth>} />
        <Route path="/invoices" element={<RequireAuth><Invoice /></RequireAuth>} />
        <Route path="/account" element={<RequireAuth><Account /></RequireAuth>} />
        <Route path="/ops" element={<Legacy />} />
      </Routes>
    </>
  )
}
