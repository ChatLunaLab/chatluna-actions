/* eslint-disable @typescript-eslint/no-namespace */
/* eslint-disable max-len */
import { Context, Logger } from 'koishi'
import { ModelService } from './service/model'
import { createLogger } from 'koishi-plugin-chatluna/utils/logger'
import { plugins } from './plugins'
import { Config } from './config'
import type {} from '@koishijs/plugin-console'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

export let logger: Logger

export function apply(ctx: Context, config: Config) {
    ctx.plugin(ModelService, config)

    logger = createLogger(ctx, 'chatluna-actions')

    ctx.inject(['chatluna_action_model'], async (ctx) => {
        await plugins(ctx, config)
    })

    ctx.inject(['console'], (ctx) => {
        const baseDir =
            typeof __dirname !== 'undefined'
                ? __dirname
                : dirname(fileURLToPath(import.meta.url))

        ctx.console.addEntry({
            dev: resolve(baseDir, '../dist'),
            prod: resolve(baseDir, '../dist')
        })
    })
}

export const inject = {
    required: ['chatluna', 'console']
}

export * from './config'
