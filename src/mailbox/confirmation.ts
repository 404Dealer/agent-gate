export function isCleanupConfirmed(answer: string): boolean {
  return answer.trim() === 'MARK READ';
}
