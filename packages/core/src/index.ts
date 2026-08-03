/**
 * @soulcloud/core — shared library for the API and broker processes.
 *
 * Contains the Prisma client, environment configuration helpers, the MQTT
 * protocol layer (topics + MessagePack codecs) and the durable command queue.
 * This package is not deployable on its own.
 */

export * from "./protocol/topic";
export * from "./protocol/command";
export * from "./protocol/stat";
export * from "./queue/errors";
export * from "./queue/enqueue";
export * from "./queue/lease";
export * from "./queue/acknowledge";
export * from "./queue/result";
export { prisma, ping } from "./db";
export { SharedEnv, loadEnv } from "./config";
export type { Config } from "./config";
export type { PrismaClient } from "../generated/prisma/client";
