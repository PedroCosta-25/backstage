/*
 * Copyright 2021 Spotify AB
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
  Entity,
  EntityName,
  stringifyEntityRef,
} from '@backstage/catalog-model';
import { CatalogClient } from '@backstage/catalog-client';
import { Config } from '@backstage/config';

export interface JenkinsInfoProvider {
  getInstance(options: {
    /**
     * The entity to get the info about.
     */
    entityRef: EntityName;
    /**
     * A specific job to get. This is only passed in when we know about a job name we are interested in.
     */
    jobName?: string;
  }): Promise<JenkinsInfo>;
}

export interface JenkinsInfo {
  baseUrl: string;
  headers?: any;
  jobName: string; // TODO: make this an array
}

export class DummyJenkinsInfoProvider implements JenkinsInfoProvider {
  async getInstance(_: {
    entityRef: EntityName;
    jobName?: string;
  }): Promise<JenkinsInfo> {
    return {
      baseUrl: 'https://jenkins.internal.example.com/',
      headers: {
        Authorization:
          'Basic YWRtaW46MTFlYzI1NmU0Mzg1MDFjM2Y1Yzc2Yjc1MWE3ZTQ3YWY4Mw==',
      },
      jobName: 'department-A/team-1/project-foo',
    };
  }
}

/**
 * Use default config and annotations.
 *
 * This will fallback through various deprecated config and annotation schemes.
 */
export class DefaultJenkinsInfoProvider implements JenkinsInfoProvider {
  static readonly OLD_JENKINS_ANNOTATION = 'jenkins.io/github-folder';
  static readonly NEW_JENKINS_ANNOTATION = 'jenkins.io/job-slug';

  constructor(
    private readonly catalog: CatalogClient,
    private readonly config: Config,
  ) {}

  async getInstance(opt: {
    entityRef: EntityName;
    jobName?: string;
  }): Promise<JenkinsInfo> {
    // load entity
    const entity = await this.catalog.getEntityByName(opt.entityRef);
    if (!entity) {
      throw new Error(
        `Couldn't find entity with name: ${stringifyEntityRef(opt.entityRef)}`,
      );
    }

    // lookup `[jenkinsName#]jobName` from entity annotation
    const jenkinsAndJobName = DefaultJenkinsInfoProvider.getEntityAnnotationValue(
      entity,
    );
    if (!jenkinsAndJobName) {
      throw new Error(
        `Couldn't find jenkins annotation (${
          DefaultJenkinsInfoProvider.NEW_JENKINS_ANNOTATION
        }) on entity with name: ${stringifyEntityRef(opt.entityRef)}`,
      );
    }

    let jobName;
    let jenkinsName: string | undefined;
    const splitIndex = jenkinsAndJobName.indexOf(':');
    if (splitIndex === -1) {
      // no jenkinsName specified, use default
      jobName = jenkinsAndJobName;
    } else {
      // There is a jenkinsName specified
      jenkinsName = jenkinsAndJobName.substring(0, splitIndex);
      jobName = jenkinsAndJobName.substring(
        splitIndex + 1,
        jenkinsAndJobName.length,
      );
    }

    // lookup baseURL + creds from config
    const instanceConfig = DefaultJenkinsInfoProvider.getInstanceConfig(
      jenkinsName,
      this.config,
    );

    const baseUrl = instanceConfig.getString('baseUrl');
    const username = instanceConfig.getString('username');
    const apiKey = instanceConfig.getString('apiKey');
    const creds = Buffer.from(`${username}:${apiKey}`, 'binary').toString(
      'base64',
    );

    return {
      baseUrl,
      headers: {
        Authorization: `Basic ${creds}`,
      },
      jobName,
    };
  }

  private static getEntityAnnotationValue(entity: Entity) {
    return (
      entity.metadata.annotations?.[
        DefaultJenkinsInfoProvider.OLD_JENKINS_ANNOTATION
      ] ||
      entity.metadata.annotations?.[
        DefaultJenkinsInfoProvider.NEW_JENKINS_ANNOTATION
      ]
    );
  }

  private static getInstanceConfig(
    jenkinsName: string | undefined,
    rootConfig: Config,
  ): Config {
    const DEFAULT_JENKINS_NAME = 'default';

    const jenkinsConfig = rootConfig.getConfig('jenkins');

    if (!jenkinsName || jenkinsName === DEFAULT_JENKINS_NAME) {
      // no name provided, this could be
      // (jenkins.baseUrl, jenkins.username, jenkins.apiKey) or
      // the entry with default name in jenkins.instances
      const namedInstanceConfig = jenkinsConfig
        .getConfigArray('instances')
        .filter(c => c.getString('name') === DEFAULT_JENKINS_NAME)[0];
      if (namedInstanceConfig) {
        return namedInstanceConfig;
      }

      // Get these as optional strings and check to give a better error message
      const baseUrl = jenkinsConfig.getOptionalString('baseUrl');
      const username = jenkinsConfig.getOptionalString('username');
      const apiKey = jenkinsConfig.getOptionalString('apiKey');

      if (!baseUrl || !username || !apiKey) {
        throw new Error(
          `Couldn't find a default jenkins instance in the config. Either configure an instance with name ${DEFAULT_JENKINS_NAME} or add a prefix to your annotation value.`,
        );
      }

      return jenkinsConfig;
    }

    // A name is provided, look it up.

    const namedInstanceConfig = jenkinsConfig
      .getConfigArray('instances')
      .filter(c => c.getString('name') === jenkinsName)[0];

    if (!namedInstanceConfig) {
      throw new Error(
        `Couldn't find a jenkins instance in the config with name ${jenkinsName}`,
      );
    }
    return namedInstanceConfig;
  }
}
