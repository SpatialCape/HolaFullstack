import { DynamoDB } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

const docClient = DynamoDBDocument.from(new DynamoDB({}));
const TABLE_NAME = process.env.TABLE_NAME;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Content-Type': 'application/json',
};

function json(body, statusCode = 200) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function parsePath(path) {
  const parts = (path || '/').replace(/^\/+/, '').split('/').filter(Boolean);
  return parts;
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const method = event.requestContext?.http?.method ?? event.httpMethod ?? 'GET';
  const path = event.rawPath ?? event.path ?? '/';
  const pathParts = parsePath(path);
  const body = event.body ? (typeof event.body === 'string' ? JSON.parse(event.body) : event.body) : null;

  try {
    // GET /tasks
    if (method === 'GET' && pathParts[0] === 'tasks' && pathParts.length === 1) {
      const { Items } = await docClient.scan({ TableName: TABLE_NAME });
      return json(Items || []);
    }

    // GET /tasks/:id
    if (method === 'GET' && pathParts[0] === 'tasks' && pathParts.length === 2) {
      const id = pathParts[1];
      const { Item } = await docClient.get({ TableName: TABLE_NAME, Key: { id } });
      if (!Item) return json({ error: 'No encontrado' }, 404);
      return json(Item);
    }

    // POST /tasks
    if (method === 'POST' && pathParts[0] === 'tasks' && pathParts.length === 1) {
      const id = crypto.randomUUID();
      const task = {
        id,
        title: body?.title ?? 'Nueva tarea',
        completed: Boolean(body?.completed),
        createdAt: new Date().toISOString(),
      };
      await docClient.put({ TableName: TABLE_NAME, Item: task });
      return json(task, 201);
    }

    // PUT /tasks/:id
    if (method === 'PUT' && pathParts[0] === 'tasks' && pathParts.length === 2) {
      const id = pathParts[1];
      const updates = [];
      const exprNames = {};
      const exprValues = {};
      if (body?.title !== undefined) {
        updates.push('#title = :title');
        exprNames['#title'] = 'title';
        exprValues[':title'] = body.title;
      }
      if (body?.completed !== undefined) {
        updates.push('#completed = :completed');
        exprNames['#completed'] = 'completed';
        exprValues[':completed'] = body.completed;
      }
      if (updates.length === 0) return json({ error: 'Nada que actualizar' }, 400);
      const { Attributes } = await docClient.update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: 'SET ' + updates.join(', '),
        ExpressionAttributeNames: exprNames,
        ExpressionAttributeValues: exprValues,
        ReturnValues: 'ALL_NEW',
      });
      return json(Attributes);
    }

    // DELETE /tasks/:id
    if (method === 'DELETE' && pathParts[0] === 'tasks' && pathParts.length === 2) {
      const id = pathParts[1];
      await docClient.delete({ TableName: TABLE_NAME, Key: { id } });
      return json({ deleted: id });
    }

    // Ruta no encontrada
    return json({ error: 'Ruta no encontrada' }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: err.message || 'Error interno' }, 500);
  }
};
