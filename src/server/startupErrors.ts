export function isAddressInUseError(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
}
