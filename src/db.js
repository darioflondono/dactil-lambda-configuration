import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  ScanCommand
} from '@aws-sdk/lib-dynamodb';
import { config } from './config.js';

const base = new DynamoDBClient({
  region: config.region,
  ...(config.ddb.endpoint ? { endpoint: config.ddb.endpoint } : {})
});

export const doc = DynamoDBDocumentClient.from(base, {
  marshallOptions: { removeUndefinedValues: true }
});

export const TABLES = config.ddb.tables;

export async function getItem(table, key) {
  const { Item } = await doc.send(new GetCommand({ TableName: table, Key: key }));
  return Item ?? null;
}

export async function putItem(table, item, { mustNotExist } = {}) {
  const params = { TableName: table, Item: item };
  if (mustNotExist) {
    const [attr] = Object.keys(mustNotExist);
    params.ConditionExpression = `attribute_not_exists(#k)`;
    params.ExpressionAttributeNames = { '#k': attr };
  }
  await doc.send(new PutCommand(params));
  return item;
}

export async function updateItem(table, key, patch) {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return getItem(table, key);

  const names = {};
  const values = {};
  const sets = entries.map(([k, v], i) => {
    names[`#f${i}`] = k;
    values[`:v${i}`] = v;
    return `#f${i} = :v${i}`;
  });

  const keyAttr = Object.keys(key)[0];
  const { Attributes } = await doc.send(
    new UpdateCommand({
      TableName: table,
      Key: key,
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: { ...names, '#pk': keyAttr },
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(#pk)',
      ReturnValues: 'ALL_NEW'
    })
  );
  return Attributes;
}

export async function deleteItem(table, key) {
  const keyAttr = Object.keys(key)[0];
  await doc.send(
    new DeleteCommand({
      TableName: table,
      Key: key,
      ExpressionAttributeNames: { '#pk': keyAttr },
      ConditionExpression: 'attribute_exists(#pk)'
    })
  );
}

/** Scan completo con paginación (para catálogos pequeños: companies / users / channels). */
export async function scanAll(table, { filter } = {}) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await doc.send(
      new ScanCommand({
        TableName: table,
        ExclusiveStartKey,
        ...(filter
          ? {
              FilterExpression: filter.expression,
              ExpressionAttributeNames: filter.names,
              ExpressionAttributeValues: filter.values
            }
          : {})
      })
    );
    items.push(...(res.Items ?? []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}
