import { forwardRef, type HTMLAttributes } from 'react'

interface BaseProps {
  title: string
  open: boolean
}

interface ModalProps extends BaseProps {
  onClose: () => void
  footer?: React.ReactNode
}

export const Modal = forwardRef<HTMLDivElement, ModalProps>(({ title, open, onClose, footer, ...rest }, ref) => {
  const Header = () => <header><h2>{title}</h2><button onClick={onClose}>×</button></header>
  if (!open) return null
  return (
    <div ref={ref} {...rest}>
      <Header />
      {footer}
    </div>
  )
})
