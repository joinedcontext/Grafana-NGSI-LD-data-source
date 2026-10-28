// Jest setup provided by Grafana scaffolding
import './.config/jest-setup';

// React's scheduler keeps a MessageChannel port open under jsdom and Jest never exits;
// without MessageChannel it falls back to setTimeout.
delete global.MessageChannel;
