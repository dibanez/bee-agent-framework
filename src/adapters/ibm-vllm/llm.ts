/**
 * Copyright 2024 IBM Corp.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  AsyncStream,
  BaseLLMOutput,
  BaseLLMTokenizeOutput,
  ExecutionOptions,
  GenerateCallbacks,
  GenerateOptions,
  LLMError,
  LLMMeta,
} from "@/llms/base.js";
import { isEmpty, isString } from "remeda";
import { BatchedGenerationRequest } from "@/adapters/ibm-vllm/types/fmaas/BatchedGenerationRequest.js";
import { SingleGenerationRequest } from "@/adapters/ibm-vllm/types/fmaas/SingleGenerationRequest.js";
import { ModelInfoRequest } from "@/adapters/ibm-vllm/types/fmaas/ModelInfoRequest.js";
import { ModelInfoResponse__Output } from "@/adapters/ibm-vllm/types/fmaas/ModelInfoResponse.js";
import { LLM, LLMInput } from "@/llms/llm.js";
import { BatchedTokenizeRequest } from "@/adapters/ibm-vllm/types/fmaas/BatchedTokenizeRequest.js";
import { BatchedTokenizeResponse__Output } from "@/adapters/ibm-vllm/types/fmaas/BatchedTokenizeResponse.js";
import { Emitter } from "@/emitter/emitter.js";
import { BatchedGenerationResponse__Output } from "@/adapters/ibm-vllm/types/fmaas/BatchedGenerationResponse.js";
import { GenerationResponse__Output } from "@/adapters/ibm-vllm/types/fmaas/GenerationResponse.js";
import { shallowCopy } from "@/serializer/utils.js";
import { FrameworkError, NotImplementedError } from "@/errors.js";
import { assign } from "@/internals/helpers/object.js";
import { wrapGrpcCall, wrapGrpcStream } from "@/adapters/ibm-vllm/utils/wrappers.js";
import { ServiceError } from "@grpc/grpc-js";
import { buildClient } from "@/adapters/ibm-vllm/utils/build-client.js";
import { GenerationServiceClient } from "@/adapters/ibm-vllm/types/fmaas/GenerationService.js";

function isGrpcServiceError(err: unknown): err is ServiceError {
  return (
    err instanceof Error &&
    err.constructor.name === "Error" &&
    "code" in err &&
    typeof err.code === "number"
  );
}

export class IBMvLLMOutput extends BaseLLMOutput {
  constructor(
    public text: string,
    public readonly meta: Record<string, any>,
  ) {
    super();
  }

  static {
    this.register();
  }

  merge(other: IBMvLLMOutput): void {
    this.text += other.text;
    assign(this.meta, other.meta);
  }

  getTextContent(): string {
    return this.text;
  }

  toString(): string {
    return this.getTextContent();
  }

  createSnapshot() {
    return {
      text: this.text,
      meta: shallowCopy(this.meta),
    };
  }

  loadSnapshot(snapshot: ReturnType<typeof this.createSnapshot>) {
    Object.assign(this, snapshot);
  }
}

export interface IBMvLLMInput {
  client?: GenerationServiceClient;
  modelId: string;
  parameters?: IBMvLLMParameters;
  executionOptions?: ExecutionOptions;
}

export type IBMvLLMParameters = NonNullable<
  BatchedGenerationRequest["params"] & SingleGenerationRequest["params"]
>;

export interface IBMvLLMGenerateOptions extends GenerateOptions {}

export class IBMvLLM extends LLM<IBMvLLMOutput, IBMvLLMGenerateOptions> {
  public readonly emitter = new Emitter<GenerateCallbacks>({
    namespace: ["grpc", "llm"],
    creator: this,
  });

  public readonly client: GenerationServiceClient;
  public readonly parameters: Partial<IBMvLLMParameters>;

  constructor({ client, modelId, parameters = {}, executionOptions }: IBMvLLMInput) {
    super(modelId, executionOptions);
    this.client = client ?? buildClient({});
    this.parameters = parameters ?? {};
  }

  static {
    this.register();
  }

  async meta(): Promise<LLMMeta> {
    const response = await wrapGrpcCall<ModelInfoRequest, ModelInfoResponse__Output>(
      this.client.modelInfo,
    )({ model_id: this.modelId });
    return {
      tokenLimit: response.max_sequence_length,
    };
  }

  async tokenize(input: LLMInput): Promise<BaseLLMTokenizeOutput> {
    try {
      const response = await wrapGrpcCall<BatchedTokenizeRequest, BatchedTokenizeResponse__Output>(
        this.client.tokenize,
      )({ model_id: this.modelId, requests: [{ text: input }] });
      const output = response.responses.at(0);
      if (!output) {
        throw new LLMError("Missing output");
      }
      return {
        tokens: output.tokens,
        tokensCount: output.token_count,
      };
    } catch (err) {
      throw this._transformError(err);
    }
  }

  protected async _generate(
    input: LLMInput,
    options?: IBMvLLMGenerateOptions,
  ): Promise<IBMvLLMOutput> {
    try {
      const response = await wrapGrpcCall<
        BatchedGenerationRequest,
        BatchedGenerationResponse__Output
      >(this.client.generate)(
        {
          model_id: this.modelId,
          requests: [{ text: input }],
          params: this._prepareParameters(options),
        },
        {
          signal: options?.signal,
        },
      );
      const output = response.responses.at(0);
      if (!output) {
        throw new Error("Missing output");
      }

      const { text, ...rest } = output;
      return new IBMvLLMOutput(text, rest);
    } catch (err) {
      throw this._transformError(err);
    }
  }

  protected async *_stream(
    input: string,
    options?: IBMvLLMGenerateOptions,
  ): AsyncStream<IBMvLLMOutput> {
    try {
      const stream = await wrapGrpcStream(this.client.generateStream)(
        {
          model_id: this.modelId,
          request: { text: input },
          params: this._prepareParameters(options),
        },
        {
          signal: options?.signal,
        },
      );
      for await (const chunk of stream) {
        const typedChunk = chunk as GenerationResponse__Output;
        const { text, ...rest } = typedChunk;
        if (text.length > 0) {
          // TODO remove condition once repetition checker is fixed in FW
          yield new IBMvLLMOutput(text, rest);
        }
      }
    } catch (err) {
      throw this._transformError(err);
    }
  }

  createSnapshot() {
    return {
      ...super.createSnapshot(),
      client: null,
      modelId: this.modelId,
      parameters: shallowCopy(this.parameters),
      executionOptions: shallowCopy(this.executionOptions),
    };
  }

  loadSnapshot(snapshot: ReturnType<typeof this.createSnapshot>) {
    super.loadSnapshot(snapshot);
    Object.assign(this, snapshot, {
      client: snapshot?.client ?? buildClient({}), // TODO: serialize?
    });
  }

  protected _transformError(error: Error): Error {
    if (error instanceof FrameworkError) {
      throw error;
    }
    if (isGrpcServiceError(error)) {
      throw new LLMError("LLM has occurred an error!", [error], {
        isRetryable: [8, 4, 14].includes(error.code),
      });
    }
    return new LLMError("LLM has occurred an error!", [error]);
  }

  protected _prepareParameters(overrides?: GenerateOptions): typeof this.parameters {
    const guided = overrides?.guided ? {} : (this.parameters.decoding ?? {});
    const guidedOverride = overrides?.guided;

    if (guidedOverride?.choice) {
      guided.choice = { ...guided.choice, choices: guidedOverride.choice };
    } else if (guidedOverride?.grammar) {
      guided.grammar = guidedOverride.grammar;
    } else if (guidedOverride?.json) {
      guided.json_schema = isString(guidedOverride.json)
        ? JSON.parse(guidedOverride.json)
        : guidedOverride.json;
    } else if (guidedOverride?.regex) {
      guided.regex = guidedOverride.regex;
    } else if (!isEmpty(guidedOverride ?? {})) {
      throw new NotImplementedError(
        `Following types ${Object.keys(overrides!.guided!).join(",")}" for the constraint decoding are not supported!`,
      );
    }

    return {
      ...this.parameters,
      decoding: guided,
    };
  }
}
