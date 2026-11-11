'use server'

// REFUSED: a server action under a layout that checks. The layout never runs for a POST to this action, so it is not
// covered.
export async function deleteSomething(name: string) {
  return { deleted: name }
}
