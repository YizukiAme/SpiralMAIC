/**
 * Next.js loads instrumentation in both Node.js and Edge runtimes. Keep the
 * Node-only startup work behind a runtime-specific import so the Edge bundle
 * never sees filesystem, database, timer, or process-signal APIs.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNodeRuntime } = await import('./instrumentation-node');
    await registerNodeRuntime();
  }
}
