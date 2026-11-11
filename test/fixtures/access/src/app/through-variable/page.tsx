// PASSES: the answer is stored, and a refusal hangs on the variable.
import { can } from '@/lib/permissions'
export default async function Page() {
  const [a, allowed] = await Promise.all([Promise.resolve(1), can(null, 'x.read')])
  if (!allowed) return null
  return a
}
