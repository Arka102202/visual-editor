import { useEffect, useState } from 'react'
import Card from '../components/Card'
import { PrimaryBtn } from '../components/Buttons'

// Three components in one file, no types at all.
function Hero({ title, subtitle = 'Welcome' }) {
  return <section><h1>{title}</h1><p>{subtitle}</p></section>
}

const FeatureList = (props) => (
  <ul>{props.items.map((i) => <li key={i.id}><Card title={i.name} onOpen={props.onPick} /></li>)}</ul>
)

export default () => {
  const [features, setFeatures] = useState([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    fetch('/api/features').then((r) => r.json()).then((d) => { setFeatures(d); setLoading(false) })
  }, [])
  if (loading) return <p>Loading</p>
  return (
    <div>
      <Hero title="Shop" />
      <FeatureList items={features} onPick={(f) => console.log(f)} />
      <PrimaryBtn label="Shop now" onClick={() => {}} />
    </div>
  )
}
