// Two buttons that are basically the same thing (copy-pasted).
export function PrimaryBtn({ label, onClick, disabled, icon, size }) {
  return (
    <button className="btn primary" onClick={onClick} disabled={disabled}>
      {icon && <span className="icon">{icon}</span>}
      <span>{label}</span>
    </button>
  )
}

export function SubmitButton({ label, onClick, disabled, icon, size }) {
  return (
    <button type="submit" className="btn submit" onClick={onClick} disabled={disabled}>
      {icon && <span className="icon">{icon}</span>}
      <span>{label}</span>
    </button>
  )
}

// Nobody uses this one anymore.
export class OldButton extends React.Component {
  render() {
    return <button onClick={this.props.onPress}>{this.props.text}</button>
  }
}
