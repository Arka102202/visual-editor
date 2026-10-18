import { memo } from 'react'

export default memo(function (props) {
  return <div className="card" onClick={() => props.onOpen(props.title)}><h3>{props.title}</h3>{props.children}</div>
})
