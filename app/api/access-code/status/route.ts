import { cookies } from 'next/headers';
import { apiSuccess } from '@/lib/server/api-response';
import { ACCESS_TOKEN_COOKIE, verifyAccessToken } from '@/lib/server/access-token';

export async function GET() {
  const accessCode = process.env.ACCESS_CODE;
  const enabled = !!accessCode;

  let authenticated = false;
  if (enabled) {
    const cookieStore = await cookies();
    const token = cookieStore.get(ACCESS_TOKEN_COOKIE)?.value;
    authenticated = !!token && verifyAccessToken(token, accessCode);
  }

  return apiSuccess({ enabled, authenticated });
}
