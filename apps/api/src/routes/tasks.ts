// Task blocks over REST. Thin: every route calls live/tasks.ts; the MCP tools
// call the same functions.
import type { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import { addTask, listAssignees, listDocumentTasks, listMyTasks, updateTask } from '../live/tasks.ts';
import { jsonBody, respond } from './choices.ts';

export function registerTaskRoutes(app: Hono<{ Variables: AppVariables }>): void {
  // The caller's tasks across documents (`assignee=me`, the only filter).
  app.get('/api/tasks', async (c) => {
    if ((c.req.query('assignee') ?? 'me') !== 'me') {
      return c.json({ error: 'bad_request', message: 'assignee must be "me"' }, 400);
    }
    return respond(c, await listMyTasks(c.get('user')));
  });

  app.get('/api/documents/:docId/tasks', async (c) => respond(c, await listDocumentTasks(c.get('user'), c.req.param('docId'))));

  app.get('/api/documents/:docId/assignees', async (c) => respond(c, await listAssignees(c.get('user'), c.req.param('docId'))));

  app.post('/api/documents/:docId/tasks', async (c) => {
    const body = await jsonBody(c);
    if (!body) return c.json({ error: 'bad_request', message: 'body must be a JSON object' }, 400);
    return respond(c, await addTask(c.get('user'), c.req.param('docId'), body as never), 201);
  });

  app.patch('/api/documents/:docId/tasks/:blockId', async (c) => {
    const body = await jsonBody(c);
    if (!body) return c.json({ error: 'bad_request', message: 'body must be a JSON object' }, 400);
    return respond(c, await updateTask(c.get('user'), c.req.param('docId'), c.req.param('blockId'), body as never));
  });
}
