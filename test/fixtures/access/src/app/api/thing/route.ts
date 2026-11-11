// REFUSED: a route handler that checks nothing; it names the check only in a comment: can(user, 'x.read').
export async function GET() { return new Response('') }
