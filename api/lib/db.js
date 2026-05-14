import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, QueryCommand, PutCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb'

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' })
export const db = DynamoDBDocumentClient.from(client)
export const TABLE = process.env.DYNAMODB_TABLE || 'momoney'

export const pk = (userId) => `USER#${userId}`

// Query all items for a user, handling DynamoDB pagination automatically
export async function queryAll(userId) {
  const items = []
  let lastKey
  do {
    const res = await db.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': pk(userId) },
      ExclusiveStartKey: lastKey,
    }))
    items.push(...(res.Items || []))
    lastKey = res.LastEvaluatedKey
  } while (lastKey)
  return items
}

// Query items with a sk prefix (e.g. 'TRADE#', 'SIGNAL#2026-05-14')
export async function queryPrefix(userId, skPrefix) {
  const items = []
  let lastKey
  do {
    const res = await db.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': pk(userId), ':prefix': skPrefix },
      ExclusiveStartKey: lastKey,
    }))
    items.push(...(res.Items || []))
    lastKey = res.LastEvaluatedKey
  } while (lastKey)
  return items
}

// Batch write up to N items (DynamoDB limit: 25 per call)
export async function batchWrite(requests) {
  const chunks = []
  for (let i = 0; i < requests.length; i += 25) chunks.push(requests.slice(i, i + 25))
  for (const chunk of chunks) {
    await db.send(new BatchWriteCommand({ RequestItems: { [TABLE]: chunk } }))
  }
}
