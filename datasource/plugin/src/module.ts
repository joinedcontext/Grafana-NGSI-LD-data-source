import { DataSourcePlugin } from '@grafana/data';

import { NgsildDataSource } from './datasource';
import { ConfigEditor } from './components/ConfigEditor';
import { QueryEditor } from './components/QueryEditor';
import { NgsildQuery, NgsildSourceOptions } from './types';

export const plugin = new DataSourcePlugin<NgsildDataSource, NgsildQuery, NgsildSourceOptions>(NgsildDataSource)
  .setConfigEditor(ConfigEditor)
  .setQueryEditor(QueryEditor);
