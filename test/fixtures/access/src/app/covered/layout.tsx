// A layout calling a refuser covers the pages and route handlers under it.
import { requireThing } from '@/lib/guards'
export default async function Layout({ children }: { children: unknown }) { await requireThing(); return children }
