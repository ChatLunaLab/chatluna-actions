import { Context, h } from 'koishi'
import { Config, logger } from '..'
import type {} from '../service/model'
import { getMessageContent } from 'koishi-plugin-chatluna/utils/string'
import {
    buildChainVariables,
    invokeChain,
    renderResult,
    resolvePreset,
    transformAndFormatMessage
} from '../utils'

export function apply(ctx: Context, config: Config) {
    const enabledCommands = config.commands.filter((command) => command.enabled)

    for (const command of enabledCommands) {
        ctx.command(
            command.command + ' <message:text>',
            command.description
        ).action(async ({ session }, message) => {
            if (
                command.model === null ||
                ctx.chatluna.platform.findModel(command.model).value == null
            ) {
                return '此命令没有选择模型，请联系管理员配置模型并重置。'
            }

            if (
                ((message == null || message === '') && session.quote) ||
                command.allowExecuteWithoutMessage
            ) {
                message = message || '[ ]'
            }

            if (!message) {
                return
            }

            logger.debug(`Received command: ${command.command} ${message}`)

            const humanMessage = await transformAndFormatMessage(
                ctx,
                session,
                message,
                command.model,
                command.inputPrompt,
                {
                    useAtAvatar: command.useAtAvatar,
                    senderAvatarMode: command.senderAvatarMode
                }
            )

            const preset = resolvePreset(
                ctx,
                command.promptType,
                command.prompt,
                command.preset
            )

            const [chain, llm] = await ctx.chatluna_action_model
                .getChain(
                    command.command,
                    command.model,
                    preset,
                    command.chatMode
                )
                .then((ref) => ref.value)

            const variables = buildChainVariables(ctx, session)

            const result = await invokeChain(
                chain,
                llm,
                humanMessage,
                variables,
                session
            )

            if (
                typeof result.content === 'string' &&
                result.content.length < 30
            ) {
                logger.debug(`Command result: ${result.content}`)
            }

            return await renderResult(ctx, result.content)
        })
    }

    const enabledInterceptCommands = config.interceptCommands.filter(
        (command) => command.enabled
    )

    ctx.before('send', async (session, options) => {
        let scope: string = session.scope ?? options?.session?.['scope']

        if (scope == null) {
            return
        }

        // remove last
        scope = scope.split('.').slice(1, -1).join('.')
        const command = ctx.$commander.resolve(scope, session)

        if (!command) {
            return
        }

        const interceptCommand = enabledInterceptCommands.find(
            (interceptCommand) => interceptCommand.command === command.name
        )

        if (!interceptCommand) {
            return
        }

        if (
            interceptCommand.model === null ||
            ctx.chatluna.platform.findModel(interceptCommand.model) == null
        ) {
            return
        }

        const transformedMessage =
            await ctx.chatluna.messageTransformer.transform(
                session,
                session.elements,
                interceptCommand.model
            )

        const humanMessage = await transformAndFormatMessage(
            ctx,
            session,
            getMessageContent(transformedMessage.content),
            interceptCommand.model,
            interceptCommand.inputPrompt
        )

        if (!humanMessage) {
            return
        }

        const preset = resolvePreset(
            ctx,
            interceptCommand.promptType,
            interceptCommand.prompt,
            interceptCommand.preset
        )

        const [chain, llm] = await ctx.chatluna_action_model
            .getChain(
                interceptCommand.command,
                interceptCommand.model,
                preset,
                interceptCommand.chatMode
            )
            .then((ref) => ref.value)

        const variables = buildChainVariables(ctx, session)
        const result = await invokeChain(
            chain,
            llm,
            humanMessage,
            variables,
            session
        )

        logger.debug(`Command result: ${result.content}`)

        const llmResult = getMessageContent(result.content)

        // replace text to llm result

        let elements = session.elements

        let findTextElement = false
        for (const element of elements) {
            if (element.type === 'text') {
                element.attrs.content = llmResult
                element.attrs.x = 0
                findTextElement = true
                break
            }
        }

        if (!findTextElement) {
            elements.push(h('text', { content: llmResult }))
        } else {
            elements = elements.filter(
                (element) =>
                    element.type !== 'text' ||
                    (element.type === 'text' && element.attrs['x'] === 0)
            )
        }

        session.elements = elements
    })
}
