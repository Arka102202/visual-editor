import React from 'react'
import { connect } from 'react-redux'

class Widget extends React.Component {
  render() {
    const { count } = this.props
    return <div>Count: {count}</div>
  }
}

export default connect((s) => ({ count: s.count }))(Widget)
