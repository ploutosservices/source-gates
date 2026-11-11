// REFUSED twice: the forbidden name is mentioned outside its allowed files (the page otherwise checks).
import { requireThing } from '@/lib/guards'
export default async function Page({ user }: { user: { isSuperUser: boolean } }) {
  await requireThing()
  return user.isSuperUser ? 'everything' : null
}
