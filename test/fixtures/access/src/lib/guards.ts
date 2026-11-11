import { can } from './permissions'
// PASSES as a guard: it checks.
export async function requireThing() { if (!(await can(null, 'x.read'))) throw new Error('no') }
// REFUSED as a guard: listed as one, checks nothing. The gate must refuse the listing.
export async function requireNothing() { return true }
