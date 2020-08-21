import { AKSClusterConfig, AKSClusterManager } from './aks'
import { AWSClusterConfig, AWSClusterManager } from './aws'
import { BaseClusterConfig, BaseClusterManager } from './base'
import { CloudProvider } from '../cloud-provider'

const clusterManagerByCloudProvider: {
  [key in CloudProvider]: (clusterConfig: BaseClusterConfig, celoEnv: string) => BaseClusterManager
} = {
  // TODO need to change this to be AWS specific
  [CloudProvider.AWS]: (clusterConfig: BaseClusterConfig, celoEnv: string) => new AWSClusterManager(clusterConfig as AWSClusterConfig, celoEnv),
  [CloudProvider.AZURE]: (clusterConfig: BaseClusterConfig, celoEnv: string) => new AKSClusterManager(clusterConfig as AKSClusterConfig, celoEnv),
}

export function getClusterManager(cloudProvider: CloudProvider, celoEnv: string, clusterConfig: BaseClusterConfig) {
  return clusterManagerByCloudProvider[cloudProvider](clusterConfig, celoEnv)
}