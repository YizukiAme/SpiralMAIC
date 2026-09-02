import { NextRequest, NextResponse } from 'next/server';
import { isAgentRuntimeConfigured, isProWorkbenchEnabled } from '@/lib/config/feature-flags';
import { ACCESS_TOKEN_COOKIE, verifyAccessToken } from '@/lib/server/access-token';

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Keep the workbench unreachable unless both its public affordance and the
  // durable server runtime are configured. Next.js 16 proxies run on Node, so
  // this can use the same complete gate as the workbench startup path.
  const workbenchEnabled = isProWorkbenchEnabled() && isAgentRuntimeConfigured();
  if (!workbenchEnabled && (pathname === '/workbench' || pathname.startsWith('/workbench/'))) {
    return new NextResponse('Not found', { status: 404 });
  }

  const accessCode = process.env.ACCESS_CODE;
  if (!accessCode) {
    return NextResponse.next();
  }

  // Whitelist: access-code endpoints, health check
  if (pathname.startsWith('/api/access-code/') || pathname === '/api/health') {
    return NextResponse.next();
  }

  // Check cookie — validate HMAC signature, not just existence
  const cookie = request.cookies.get(ACCESS_TOKEN_COOKIE);
  if (cookie?.value && verifyAccessToken(cookie.value, accessCode)) {
    return NextResponse.next();
  }

  // API requests without valid cookie → 401
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error: 'Access code required' },
      { status: 401 },
    );
  }

  // Page requests → let through, frontend shows modal
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|logos/).*)'],
};
