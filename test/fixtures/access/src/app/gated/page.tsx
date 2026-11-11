// PASSES: a refusal hangs on can() directly.
import { can } from '@/lib/permissions'
import { notFound } from 'next/navigation'
export default async function Page() {
  if (!(await can(null, 'x.read'))) notFound()
  return null
}
