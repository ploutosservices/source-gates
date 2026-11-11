// REFUSED: can() decides only whether a link shows; no refusal hangs on it.
import { can } from '@/lib/permissions'
export default async function Page() {
  const canWrite = await can(null, 'x.write')
  return canWrite ? 'link' : null
}
