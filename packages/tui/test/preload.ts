/**
 * Test preload script to ensure consistent test environment.
 *
 * Clears multiplexer environment variables (TMUX, STY, ZELLIJ) so tests
 * behave consistently whether run inside or outside a terminal multiplexer.
 */

delete process.env.TMUX;
delete process.env.STY;
delete process.env.ZELLIJ;

// Also clear Bun.env which may be a separate cache
delete Bun.env.TMUX;
delete Bun.env.STY;
delete Bun.env.ZELLIJ;
