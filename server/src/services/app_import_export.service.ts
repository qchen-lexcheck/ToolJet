import { BadRequestException, Injectable } from '@nestjs/common';
import { App } from 'src/entities/app.entity';
import { EntityManager } from 'typeorm';
import { User } from 'src/entities/user.entity';
import { DataSource } from 'src/entities/data_source.entity';
import { DataQuery } from 'src/entities/data_query.entity';
import { AppVersion } from 'src/entities/app_version.entity';
import { GroupPermission } from 'src/entities/group_permission.entity';
import { AppGroupPermission } from 'src/entities/app_group_permission.entity';
import { DataSourcesService } from './data_sources.service';
import { dbTransactionWrap } from 'src/helpers/utils.helper';
import { isEmpty } from 'lodash';
import { AppEnvironment } from 'src/entities/app_environments.entity';
import { DataSourceOptions } from 'src/entities/data_source_options.entity';

@Injectable()
export class AppImportExportService {
  constructor(private dataSourcesService: DataSourcesService, private readonly entityManager: EntityManager) {}

  async export(user: User, id: string): Promise<App> {
    // https://github.com/typeorm/typeorm/issues/3857
    // Making use of query builder
    return await dbTransactionWrap(async (manager: EntityManager) => {
      const queryForAppToExport = manager
        .createQueryBuilder(App, 'apps')
        .where('apps.id = :id AND apps.organization_id = :organizationId', {
          id,
          organizationId: user.organizationId,
        });
      const appToExport = await queryForAppToExport.getOne();

      const appVersions = await manager
        .createQueryBuilder(AppVersion, 'app_versions')
        .where('appId = :appId', {
          appId: appToExport.id,
        })
        .orderBy('app_versions.created_at', 'ASC')
        .getMany();

      const dataSources = await manager
        .createQueryBuilder(DataSource, 'data_sources')
        .where('appVersionId IN(:versionId)', {
          versionId: appVersions.map((v) => v.id),
        })
        .orderBy('data_sources.created_at', 'ASC')
        .getMany();

      const dataQueries = await manager
        .createQueryBuilder(DataQuery, 'data_queries')
        .where('dataSourceId IN(:dataSourceId)', {
          dataSourceId: dataSources.map((v) => v.id),
        })
        .orderBy('data_queries.created_at', 'ASC')
        .getMany();

      const appEnvironments = await manager
        .createQueryBuilder(AppEnvironment, 'app_environments')
        .where('appVersionId IN(:versionId)', {
          versionId: appVersions.map((v) => v.id),
        })
        .orderBy('app_environments.createdAt', 'ASC')
        .getMany();

      const dataSourceOptions = await manager
        .createQueryBuilder(DataSourceOptions, 'data_source_options')
        .where('environmentId IN(:environmentId)', {
          versionId: appEnvironments.map((v) => v.id),
        })
        .orderBy('data_source_options.createdAt', 'ASC')
        .getMany();

      appToExport['dataQueries'] = dataQueries;
      appToExport['dataSources'] = dataSources;
      appToExport['appVersions'] = appVersions;
      appToExport['appEnvironments'] = appEnvironments;
      appToExport['dataSourceOptions'] = dataSourceOptions;

      return appToExport;
    });
  }

  async import(user: User, appParams: any): Promise<App> {
    if (typeof appParams !== 'object') {
      throw new BadRequestException('Invalid params for app import');
    }

    let importedApp: App;

    await dbTransactionWrap(async (manager) => {
      importedApp = await this.createImportedAppForUser(manager, appParams, user);
      await this.buildImportedAppAssociations(manager, importedApp, appParams);
      await this.createAdminGroupPermissions(manager, importedApp);
    });

    // NOTE: App slug updation callback doesn't work while wrapped in transaction
    // hence updating slug explicitly
    await importedApp.reload();
    importedApp.slug = importedApp.id;
    await this.entityManager.save(importedApp);

    return importedApp;
  }

  async createImportedAppForUser(manager: EntityManager, appParams: any, user: User): Promise<App> {
    const importedApp = manager.create(App, {
      name: appParams.name,
      organizationId: user.organizationId,
      userId: user.id,
      slug: null, // Prevent db unique constraint error.
      isPublic: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await manager.save(importedApp);
    return importedApp;
  }

  async buildImportedAppAssociations(manager: EntityManager, importedApp: App, appParams: any) {
    const dataSourceMapping = {};
    const dataSourceOptionsMapping = {};
    const dataQueryMapping = {};
    const appVersionMapping = {};
    const appEnvironmentMapping = {};
    const appDefaultEnvironmentMapping = {};
    let currentVersionId: string;
    const dataSources = appParams?.dataSources || [];
    const dataQueries = appParams?.dataQueries || [];
    const appVersions = appParams?.appVersions || [];
    const appEnvironments = appParams?.appEnvironments || [];
    const dataSourceOptions = appParams?.dataSourceOptions || [];

    // create new app versions
    for (const appVersion of appVersions) {
      const version = manager.create(AppVersion, {
        appId: importedApp.id,
        definition: appVersion.definition,
        name: appVersion.name,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await manager.save(version);

      if (!appEnvironments?.length) {
        const env = manager.create(AppEnvironment, {
          appVersionId: version.id,
          name: 'production',
          isDefault: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        await manager.save(env);
        appDefaultEnvironmentMapping[appVersion.id] = env.id;
      }

      if (appVersion.id == appParams.currentVersionId) {
        currentVersionId = version.id;
        await manager.update(App, importedApp, { currentVersionId });
      }
      appVersionMapping[appVersion.id] = version.id;
    }

    // associate App environments for each of the app versions
    for (const appVersion of appVersions) {
      for (const appEnvironment of appEnvironments) {
        const env = manager.create(AppEnvironment, {
          appVersionId: appVersionMapping[appEnvironment.versionId],
          name: appEnvironment.name,
          isDefault: appEnvironment.isDefault,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        await manager.save(env);

        appEnvironmentMapping[appEnvironment.id] = env.id;
      }

      // associate data sources and queries for each of the app versions
      for (const source of dataSources) {
        if (source.options) {
          // Old version
          const convertedOptions = this.convertToArrayOfKeyValuePairs(source.options);
          const newOptions = await this.dataSourcesService.parseOptionsForCreate(convertedOptions, false, manager);
          dataSourceOptionsMapping[source.id] = newOptions;
        }

        let appVersionId: any;

        // Handle exports prior to 0.12.0
        // If there are more variances in imports when tooljet version changes,
        // we can split this service based on app export definition's tooljet version.
        if (source.appVersionId) {
          if (source.appVersionId !== appVersion.id) {
            continue;
          }
          appVersionId = appVersionMapping[appVersion.id];
        } else {
          appVersionId = appVersionMapping[appVersion.id];
        }
        const newSource = manager.create(DataSource, {
          name: source.name,
          kind: source.kind,
          appVersionId,
        });
        await manager.save(newSource);
        dataSourceMapping[source.id] = newSource.id;
      }

      if (!dataSourceOptions?.length && dataSourceOptionsMapping) {
        for (const source of dataSources) {
          const dsOption = manager.create(DataSourceOptions, {
            environmentId: appDefaultEnvironmentMapping[appVersion.id],
            dataSourceId: source.id,
            options: dataSourceOptionsMapping[source.id],
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          await manager.save(dsOption);
        }
      }

      for (const dataSourceOption of dataSourceOptions) {
        const dsOption = manager.create(DataSourceOptions, {
          options: dataSourceOption.options,
          environmentId: appEnvironmentMapping[dataSourceOption.environmentId],
          dataSource: dataSourceMapping[dataSourceOption.dataSource],
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        await manager.save(dsOption);
      }

      const newDataQueries = [];
      for (const query of dataQueries) {
        const newQuery = manager.create(DataQuery, {
          name: query.name,
          options: query.options,
          kind: query.kind,
          dataSourceId: dataSourceMapping[query.dataSourceId],
        });
        await manager.save(newQuery);
        dataQueryMapping[query.id] = newQuery.id;
        newDataQueries.push(newQuery);
      }

      for (const newQuery of newDataQueries) {
        const newOptions = this.replaceDataQueryOptionsWithNewDataQueryIds(newQuery.options, dataQueryMapping);
        newQuery.options = newOptions;
        await manager.save(newQuery);
      }

      const version = await manager.findOne(AppVersion, {
        where: { id: appVersionMapping[appVersion.id] },
      });
      version.definition = this.replaceDataQueryIdWithinDefinitions(version.definition, dataQueryMapping);
      await manager.save(version);
    }

    await this.setEditingVersionAsLatestVersion(manager, appVersionMapping, appVersions);
  }

  async setEditingVersionAsLatestVersion(manager: EntityManager, appVersionMapping: any, appVersions: Array<any>) {
    if (isEmpty(appVersions)) return;

    const lastVersionFromImport = appVersions[appVersions.length - 1];
    const lastVersionIdToUpdate = appVersionMapping[lastVersionFromImport.id];

    await manager.update(AppVersion, { id: lastVersionIdToUpdate }, { updatedAt: new Date() });
  }

  async createAdminGroupPermissions(manager: EntityManager, app: App) {
    const orgDefaultGroupPermissions = await manager.find(GroupPermission, {
      where: {
        organizationId: app.organizationId,
        group: 'admin',
      },
    });

    const adminPermissions = {
      read: true,
      update: true,
      delete: true,
    };

    for (const groupPermission of orgDefaultGroupPermissions) {
      const appGroupPermission = manager.create(AppGroupPermission, {
        groupPermissionId: groupPermission.id,
        appId: app.id,
        ...adminPermissions,
      });

      return await manager.save(AppGroupPermission, appGroupPermission);
    }
  }

  convertToArrayOfKeyValuePairs(options): Array<object> {
    return Object.keys(options).map((key) => {
      return {
        key: key,
        value: options[key]['value'],
        encrypted: options[key]['encrypted'],
      };
    });
  }

  replaceDataQueryOptionsWithNewDataQueryIds(options, dataQueryMapping) {
    if (options && options.events) {
      const replacedEvents = options.events.map((event) => {
        if (event.queryId) {
          event.queryId = dataQueryMapping[event.queryId];
        }
        return event;
      });
      options.events = replacedEvents;
    }
    return options;
  }

  replaceDataQueryIdWithinDefinitions(definition, dataQueryMapping) {
    if (definition?.components) {
      for (const id of Object.keys(definition.components)) {
        const component = definition.components[id].component;

        if (component?.definition?.events) {
          const replacedComponentEvents = component.definition.events.map((event) => {
            if (event.queryId) {
              event.queryId = dataQueryMapping[event.queryId];
            }
            return event;
          });
          component.definition.events = replacedComponentEvents;
        }

        if (component?.definition?.properties?.actions?.value) {
          for (const value of component.definition.properties.actions.value) {
            if (value?.events) {
              const replacedComponentActionEvents = value.events.map((event) => {
                if (event.queryId) {
                  event.queryId = dataQueryMapping[event.queryId];
                }
                return event;
              });
              value.events = replacedComponentActionEvents;
            }
          }
        }

        if (component?.component === 'Table') {
          for (const column of component?.definition?.properties?.columns?.value ?? []) {
            if (column?.events) {
              const replacedComponentActionEvents = column.events.map((event) => {
                if (event.queryId) {
                  event.queryId = dataQueryMapping[event.queryId];
                }
                return event;
              });
              column.events = replacedComponentActionEvents;
            }
          }
        }

        definition.components[id].component = component;
      }
    }
    return definition;
  }
}
