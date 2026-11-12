import { withAccessCode } from '@/lib/server/with-access-code';
import { NextResponse } from 'next/server';
import { getGitHubStars } from '@/lib/server/github-stars';

// Answered per request from the in-memory cache, never prerendered at build time.
export const dynamic = 'force-dynamic';

/** The repository's star count for the home badge: `{ stars: number | null }`, never an error. */
async function GETHandler(_request: Request) {
  let stars: number | null = null;
  try {
    stars = await getGitHubStars();
  } catch {
    stars = null;
  }
  return NextResponse.json({ stars });
}

export const GET = withAccessCode(GETHandler);
