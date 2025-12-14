import { StructuredTool } from '@langchain/core/tools'
import { Context, h, Session } from 'koishi'
import { Config } from '..'
import { z } from 'zod'
import { ChatLunaToolRunnable } from 'koishi-plugin-chatluna/llm-core/platform/types'
import { CallbackManagerForToolRun } from '@langchain/core/callbacks/manager'
import {
    buildChainVariables,
    invokeChain,
    normalizeCommandName,
    resolvePreset,
    transformAndFormatMessage
} from '../utils'
import {
    getMessageContent,
    isMessageContentImageUrl,
    isMessageContentText
} from 'koishi-plugin-chatluna/utils/string'
import { MessageContent } from '@langchain/core/messages'

export function apply(ctx: Context, config: Config) {
    const toolCommands = config.commands.filter(
        (cmd) => cmd.enabled && cmd.registerAsTool
    )

    for (const command of toolCommands) {
        const normalizedName = normalizeCommandName(command.command)

        ctx.effect(() =>
            ctx.chatluna.platform.registerTool(`action_${normalizedName}`, {
                createTool() {
                    return new ActionTool(ctx, command)
                },
                selector(history) {
                    return true
                }
            })
        )
    }
}

class ActionTool extends StructuredTool {
    name: string
    description: string
    schema = z.object({
        input: z.string().describe('User input for the action')
    })

    ref: Awaited<ReturnType<Context['chatluna_action_model']['getChain']>>

    constructor(
        private ctx: Context,
        private command: Config['commands'][0]
    ) {
        super()
        this.name = normalizeCommandName(this.command.command)
        this.description = this.command.description || 'Execute action'

        ctx.on('ready', async () => {
            const preset = resolvePreset(
                this.ctx,
                this.command.promptType,
                this.command.prompt,
                this.command.preset
            )

            this.ref = await this.ctx.chatluna_action_model.getChain(
                this.command.command,
                this.command.model,
                preset,
                this.command.chatMode
            )
        })
    }

    async _call(
        input: { input: string },
        runManager: CallbackManagerForToolRun,
        config: ChatLunaToolRunnable
    ) {
        const session = config.configurable.session

        try {
            const humanMessage = await transformAndFormatMessage(
                this.ctx,
                session,
                input.input,
                this.command.model,
                this.command.inputPrompt
            )

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const [chain, llm] = this.ref as unknown as any

            const variables = buildChainVariables(this.ctx, session)
            const result = await invokeChain(
                chain,
                llm,
                humanMessage,
                variables,
                session
            )

            return await this.processResult(result.content, session)
        } catch (e) {
            this.ctx.logger.error(e)
            return `Action execution failed: ${e.message}`
        }
    }

    private async processResult(
        content: MessageContent,
        session: Session
    ): Promise<string> {
        const sendQueue: h[] = []

        if (typeof content === 'string') {
            return content
        }

        if (Array.isArray(content)) {
            const results: string[] = []

            for (const part of content) {
                if (isMessageContentText(part)) {
                    results.push(part.text)
                } else if (isMessageContentImageUrl(part)) {
                    const imageUrl =
                        typeof part.image_url === 'string'
                            ? part.image_url
                            : part.image_url.url

                    if (imageUrl.includes('data:')) {
                        sendQueue.push(h.image(imageUrl))
                        results.push(`[image:${imageUrl.substring(0, 12)}]`)
                    } else {
                        results.push(`Image url:${imageUrl}`)
                    }
                }
            }

            if (sendQueue.length > 0) {
                await session.send(sendQueue)
            }

            return results.join('\n\n')
        }

        return getMessageContent(content)
    }
}
