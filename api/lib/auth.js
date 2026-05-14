import { verifyToken } from '@clerk/backend'

export async function getUserId(req) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  try {
    const token = header.slice(7)
    const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY })
    return payload.sub
  } catch {
    return null
  }
}
