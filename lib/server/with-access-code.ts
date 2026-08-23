import { apiError } from '@/lib/server/api-response';
import { readAccessTokenCookie, verifyAccessToken } from '@/lib/server/access-token';

function accessDenied(): Response {
  const response = apiError('INVALID_REQUEST', 401, 'Access code required');
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export function withAccessCode<TArgs extends unknown[]>(
  handler: (...args: TArgs) => Response | Promise<Response>,
): (...args: TArgs) => Promise<Response> {
  return async (...args: TArgs): Promise<Response> => {
    const accessCode = process.env.ACCESS_CODE;
    if (!accessCode) return handler(...args);

    const request = args[0];
    if (!(request instanceof Request)) {
      return accessDenied();
    }
    const token = readAccessTokenCookie(request);
    if (!token || !verifyAccessToken(token, accessCode)) {
      return accessDenied();
    }

    return handler(...args);
  };
}
