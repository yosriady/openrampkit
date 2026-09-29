import { Playground } from '@/components/Playground'
import { isMock } from '@/lib/openramp'

export default function Page() {
  return <Playground mock={isMock} />
}
