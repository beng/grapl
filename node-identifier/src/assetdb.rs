use graph_descriptions::graph_description::*;
use graph_descriptions::*;
use graph_descriptions::graph_description::host::*;

use failure::Error;
use futures::future::Future;
use rusoto_dynamodb::{
    AttributeValue, Condition, DeleteItemInput, DynamoDb, DynamoDbClient, GetItemInput,
    ListTablesInput, PutItemInput, QueryInput, Update, UpdateItemInput,
};
use std::time::Duration;

#[derive(Debug, Serialize, Deserialize)]
pub struct ResolvedAssetId {
    pub asset_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AssetIdMapping {
    pub pseudo_key: String,
    pub asset_id: String,
    pub c_timestamp: u64,
}

#[derive(Debug, Clone)]
pub struct AssetIdDb<D>
where
    D: DynamoDb,
{
    dynamo: D,
}

impl<D> AssetIdDb<D>
where
    D: DynamoDb,
{
    pub fn new(dynamo: D) -> Self {
        Self { dynamo }
    }

    pub fn find_first_mapping_after(
        &self,
        host_id: &HostId,
        ts: u64,
    ) -> Result<Option<String>, Error> {
        let (table_key, pseudo_key) = match host_id {
            HostId::AssetId(asset_id) => return Ok(Some(asset_id.to_owned())),
            HostId::Hostname(hostname) => ("hostname", hostname.as_str()),
            HostId::Ip(ip) => ("ip", ip.as_str()),
        };

        let query = QueryInput {
            consistent_read: Some(true),
            limit: Some(1),
            table_name: "asset_id_mappings".to_owned(),
            key_condition_expression: Some(
                "pseudo_key = :pkey_val AND c_timestamp >= :c_timestamp".into(),
            ),
            expression_attribute_values: Some(hmap! {
                ":pkey_val".to_owned() => AttributeValue {
                    s: format!("{}{}", table_key, pseudo_key).into(),
                    ..Default::default()
                },
                ":c_timestamp".to_owned() => AttributeValue {
                    n: ts.to_string().into(),
                    ..Default::default()
                }
            }),
            ..Default::default()
        };

        let res = wait_on!(self.dynamo.query(query))?;

        if let Some(items) = res.items {
            match &items[..] {
                [] => Ok(None),
                [item] => {
                    let asset_id: ResolvedAssetId = serde_dynamodb::from_hashmap(item.clone())?;
                    Ok(Some(asset_id.asset_id))
                }
                _ => bail!("Unexpected number of items returned"),
            }
        } else {
            Ok(None)
        }
    }

    pub fn find_last_mapping_before(
        &self,
        host_id: &HostId,
        ts: u64,
    ) -> Result<Option<String>, Error> {
        //        info!("Finding last mapping before");
        let (table_key, pseudo_key) = match host_id {
            HostId::AssetId(asset_id) => return Ok(Some(asset_id.to_owned())),
            HostId::Hostname(hostname) => ("hostname", hostname.as_str()),
            HostId::Ip(ip) => ("ip", ip.as_str()),
        };

        let query = QueryInput {
            consistent_read: Some(true),
            limit: Some(1),
            scan_index_forward: Some(false),
            table_name: "asset_id_mappings".to_owned(),
            key_condition_expression: Some(
                "pseudo_key = :pseudo_key AND c_timestamp <= :c_timestamp".into(),
            ),
            expression_attribute_values: Some(hmap! {
                ":pseudo_key".to_owned() => AttributeValue {
                    s: format!("{}{}", table_key, pseudo_key).into(),
                    ..Default::default()
                },
                ":c_timestamp".to_owned() => AttributeValue {
                    n: ts.to_string().into(),
                    ..Default::default()
                }
            }),
            ..Default::default()
        };

        let res = wait_on!(self.dynamo.query(query))?;

        if let Some(items) = res.items {
            match &items[..] {
                [] => Ok(None),
                [item] => {
                    let asset_id: ResolvedAssetId = serde_dynamodb::from_hashmap(item.clone())?;
                    Ok(Some(asset_id.asset_id))
                }
                _ => bail!("Unexpected number of items returned"),
            }
        } else {
            Ok(None)
        }
    }

    pub fn resolve_asset_id(&self, host_id: &HostId, ts: u64) -> Result<Option<String>, Error> {
        if let Some(session_id) = self.find_last_mapping_before(host_id, ts)? {
            Ok(Some(session_id))
        } else {
            self.find_first_mapping_after(host_id, ts)
        }
    }

    pub fn create_mapping(&self, host_id: &HostId, asset_id: String, ts: u64) -> Result<(), Error> {
        let (table_key, host_id) = match host_id {
            HostId::AssetId(id) => return Ok(()),
            HostId::Hostname(hostname) => ("hostname", hostname.as_str()),
            HostId::Ip(ip) => ("ip", ip.as_str()),
        };

        let mapping = AssetIdMapping {
            pseudo_key: format!("{}{}", table_key, host_id),
            asset_id: asset_id.clone(),
            c_timestamp: ts,
        };

        let put_req = PutItemInput {
            item: serde_dynamodb::to_hashmap(&mapping).unwrap(),
            table_name: "asset_id_mappings".to_owned(),
            ..Default::default()
        };

        let put_item_response = wait_on!(self.dynamo.put_item(put_req))?;

        info!(
            "PutItemResponse for {:?} {}: {:?}",
            host_id, asset_id, put_item_response
        );

        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct AssetIdentifier<D>
    where D: DynamoDb
{
    assetdb: AssetIdDb<D>,
}

impl<D> AssetIdentifier<D>
    where D: DynamoDb
{
    pub fn new(
        assetdb: AssetIdDb<D>
    ) -> Self {
        Self {assetdb}
    }

    pub fn attribute_asset_id(
        &self,
        node: NodeDescription,
    ) -> Result<String, Error> {
        let ids = match node.clone().which() {
            Node::ProcessNode(node) => (node.asset_id, node.hostname, node.host_ip),
            Node::FileNode(node) => (node.asset_id, node.hostname, node.host_ip),
            Node::OutboundConnectionNode(node) => (node.asset_id, node.hostname, node.host_ip),
            Node::DynamicNode(node) => (node.asset_id, node.hostname, node.host_ip),
            Node::IpAddressNode(_) => {
                bail!("Can not call attribute_asset_id with IpAddressNode")
            }
            _ => panic!("Unsupported node type"),
        };

        let host_id = match ids {
            (Some(asset_id), _, _) => HostId::AssetId(asset_id.clone()),
            (_, Some(hostname), _) => HostId::Hostname(hostname.clone()),
            (_, _, Some(host_ip)) => HostId::Ip(host_ip.clone()),
            (_, _, _) => {
                bail!("Must provide at least one of: asset_id, hostname, host_ip");
            }
        };

        // map host_id to asset_id
        // If we don't finya oim talking ad an asset id we'll have to mark the node as dead
        let asset_id = self.assetdb.resolve_asset_id(&host_id, node.get_timestamp());

        match asset_id {
            Ok(Some(asset_id)) => Ok(asset_id),
            Ok(None) => bail!("Failed to resolve assetid"),
            Err(e) => bail!("Failed to resolve assetid {}", e),
        }

    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use rusoto_core::Region;

    // Given a hostname 'H' to asset id 'A' mapping at c_timestamp 'X'
    // When attributing 'H' at c_timestamp 'Y', where 'Y' > 'X'
    // Then we should retrieve asset id 'A'
    #[test]
    fn map_hostname_to_asset_id() {
        let region = Region::Custom {
            endpoint: "http://localhost:8000".to_owned(),
            name: "us-east-9".to_owned(),
        };

        let asset_id_db = AssetIdDb::new(DynamoDbClient::new(region.clone()));

        asset_id_db
            .create_mapping(
                &HostId::Hostname("fakehostname".to_owned()),
                "asset_id_a".into(),
                1500,
            )
            .expect("Mapping creation failed");

        let mapping = asset_id_db
            .resolve_asset_id(&HostId::Hostname("fakehostname".to_owned()), 1510)
            .expect("Failed to resolve asset id mapping")
            .expect("Failed to resolve asset id mapping");

        assert_eq!(mapping, "asset_id_a");
    }
}
