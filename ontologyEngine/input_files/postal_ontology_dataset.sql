-- ===================================================================
-- Postal & Logistics Operational Ontology  --  Sample Dataset (DDL + DATA)
-- Target dialect: PostgreSQL 14+ (ANSI-friendly; adjust types as needed)
-- Generated for solution-architecture demo. All data is SYNTHETIC.
-- Object Types -> tables | Link Types -> FKs & association tables
-- Action Types -> action_type (catalog) + action_execution_log (audit)
-- ===================================================================

BEGIN;

DROP TABLE IF EXISTS action_execution_log CASCADE;
DROP TABLE IF EXISTS action_type CASCADE;
DROP TABLE IF EXISTS telemetry_event CASCADE;
DROP TABLE IF EXISTS consignment_vehicle_assignment CASCADE;
DROP TABLE IF EXISTS shipment_consignment CASCADE;
DROP TABLE IF EXISTS transport_vehicle CASCADE;
DROP TABLE IF EXISTS linehaul_route CASCADE;
DROP TABLE IF EXISTS driver CASCADE;
DROP TABLE IF EXISTS carrier CASCADE;
DROP TABLE IF EXISTS hub CASCADE;

-- --------------------------------------------------------------------
-- hub   (Ontology: Hub)
-- Grain: One physical sorting facility in the network.
-- --------------------------------------------------------------------
CREATE TABLE hub (
    hub_id                     VARCHAR(16) NOT NULL,
    hub_name                   VARCHAR(80) NOT NULL,
    hub_type                   VARCHAR(16) NOT NULL,
    city                       VARCHAR(60) NOT NULL,
    country                    CHAR(2) NOT NULL,
    latitude                   DECIMAL(9,6) NOT NULL,
    longitude                  DECIMAL(9,6) NOT NULL,
    processing_capacity_hr     INTEGER NOT NULL,
    current_utilization_pct    SMALLINT NOT NULL,
    status                     VARCHAR(12) NOT NULL,
    operating_window           VARCHAR(11) NOT NULL,
    sensitivity_marking        VARCHAR(24) NOT NULL,
    last_telemetry_ts          TIMESTAMP NOT NULL,
    CONSTRAINT pk_hub PRIMARY KEY (hub_id)
);

-- --------------------------------------------------------------------
-- carrier   (Ontology: Carrier)
-- Grain: A haulage provider (in-house fleet or contracted 3PL).
-- --------------------------------------------------------------------
CREATE TABLE carrier (
    carrier_id                 VARCHAR(16) NOT NULL,
    carrier_name               VARCHAR(60) NOT NULL,
    carrier_type               VARCHAR(16) NOT NULL,
    home_country               CHAR(2) NOT NULL,
    reliability_rating         SMALLINT NOT NULL,
    cost_index                 DECIMAL(4,2) NOT NULL,
    certifications             VARCHAR(40),
    CONSTRAINT pk_carrier PRIMARY KEY (carrier_id)
);

-- --------------------------------------------------------------------
-- driver   (Ontology: Driver)
-- Grain: A linehaul driver bound to a home hub and a carrier.
-- --------------------------------------------------------------------
CREATE TABLE driver (
    driver_id                  VARCHAR(16) NOT NULL,
    driver_name                VARCHAR(60) NOT NULL,
    home_hub_id                VARCHAR(16) NOT NULL,
    carrier_id                 VARCHAR(16) NOT NULL,
    hours_available_today      DECIMAL(4,2) NOT NULL,
    status                     VARCHAR(12) NOT NULL,
    certifications             VARCHAR(40),
    CONSTRAINT pk_driver PRIMARY KEY (driver_id),
    CONSTRAINT fk_driver_home_hub_id FOREIGN KEY (home_hub_id) REFERENCES hub(hub_id),
    CONSTRAINT fk_driver_carrier_id FOREIGN KEY (carrier_id) REFERENCES carrier(carrier_id)
);

-- --------------------------------------------------------------------
-- linehaul_route   (Ontology: LinehaulRoute)
-- Grain: A scheduled trunk connection between two hubs.
-- --------------------------------------------------------------------
CREATE TABLE linehaul_route (
    route_id                   VARCHAR(20) NOT NULL,
    origin_hub_id              VARCHAR(16) NOT NULL,
    destination_hub_id         VARCHAR(16) NOT NULL,
    distance_km                INTEGER NOT NULL,
    planned_transit_min        INTEGER NOT NULL,
    mode                       VARCHAR(8) NOT NULL,
    active_carrier_id          VARCHAR(16) NOT NULL,
    departure_time             VARCHAR(5) NOT NULL,
    reliability_pct            SMALLINT NOT NULL,
    status                     VARCHAR(10) NOT NULL,
    CONSTRAINT pk_linehaul_route PRIMARY KEY (route_id),
    CONSTRAINT fk_linehaul_route_origin_hub_id FOREIGN KEY (origin_hub_id) REFERENCES hub(hub_id),
    CONSTRAINT fk_linehaul_route_destination_hub_id FOREIGN KEY (destination_hub_id) REFERENCES hub(hub_id),
    CONSTRAINT fk_linehaul_route_active_carrier_id FOREIGN KEY (active_carrier_id) REFERENCES carrier(carrier_id)
);

-- --------------------------------------------------------------------
-- transport_vehicle   (Ontology: TransportVehicle)
-- Grain: A physical vehicle emitting telemetry, optionally on a route.
-- --------------------------------------------------------------------
CREATE TABLE transport_vehicle (
    vehicle_id                 VARCHAR(16) NOT NULL,
    registration_plate         VARCHAR(12) NOT NULL,
    vehicle_type               VARCHAR(16) NOT NULL,
    capacity_parcels           INTEGER NOT NULL,
    current_latitude           DECIMAL(9,6),
    current_longitude          DECIMAL(9,6),
    current_route_id           VARCHAR(20),
    assigned_driver_id         VARCHAR(16),
    status                     VARCHAR(12) NOT NULL,
    fuel_or_soc_pct            SMALLINT,
    telemetry_ts               TIMESTAMP NOT NULL,
    CONSTRAINT pk_transport_vehicle PRIMARY KEY (vehicle_id),
    CONSTRAINT fk_transport_vehicle_current_route_id FOREIGN KEY (current_route_id) REFERENCES linehaul_route(route_id),
    CONSTRAINT fk_transport_vehicle_assigned_driver_id FOREIGN KEY (assigned_driver_id) REFERENCES driver(driver_id)
);

-- --------------------------------------------------------------------
-- shipment_consignment   (Ontology: ShipmentConsignment)
-- Grain: A batch of parcels moving under one SLA toward a target hub.
-- --------------------------------------------------------------------
CREATE TABLE shipment_consignment (
    consignment_id             VARCHAR(20) NOT NULL,
    parcel_count               INTEGER NOT NULL,
    service_type               VARCHAR(18) NOT NULL,
    sla_level                  VARCHAR(14) NOT NULL,
    origin_hub_id              VARCHAR(16) NOT NULL,
    target_hub_id              VARCHAR(16) NOT NULL,
    current_hub_id             VARCHAR(16),
    sla_deadline               TIMESTAMP NOT NULL,
    total_weight_kg            DECIMAL(9,1) NOT NULL,
    declared_value_eur         DECIMAL(12,2) NOT NULL,
    status                     VARCHAR(12) NOT NULL,
    sensitivity_marking        VARCHAR(24) NOT NULL,
    CONSTRAINT pk_shipment_consignment PRIMARY KEY (consignment_id),
    CONSTRAINT fk_shipment_consignment_origin_hub_id FOREIGN KEY (origin_hub_id) REFERENCES hub(hub_id),
    CONSTRAINT fk_shipment_consignment_target_hub_id FOREIGN KEY (target_hub_id) REFERENCES hub(hub_id),
    CONSTRAINT fk_shipment_consignment_current_hub_id FOREIGN KEY (current_hub_id) REFERENCES hub(hub_id)
);

-- --------------------------------------------------------------------
-- consignment_vehicle_assignment   (Ontology: Link: ShipmentConsignment assigned_to TransportVehicle)
-- Grain: Association row binding a consignment to a vehicle for one leg.
-- --------------------------------------------------------------------
CREATE TABLE consignment_vehicle_assignment (
    assignment_id              VARCHAR(20) NOT NULL,
    consignment_id             VARCHAR(20) NOT NULL,
    vehicle_id                 VARCHAR(16) NOT NULL,
    route_id                   VARCHAR(20) NOT NULL,
    leg_sequence               SMALLINT NOT NULL,
    assigned_ts                TIMESTAMP NOT NULL,
    status                     VARCHAR(12) NOT NULL,
    CONSTRAINT pk_consignment_vehicle_assignment PRIMARY KEY (assignment_id),
    CONSTRAINT fk_consignment_vehicle_assignment_consignment_id FOREIGN KEY (consignment_id) REFERENCES shipment_consignment(consignment_id),
    CONSTRAINT fk_consignment_vehicle_assignment_vehicle_id FOREIGN KEY (vehicle_id) REFERENCES transport_vehicle(vehicle_id),
    CONSTRAINT fk_consignment_vehicle_assignment_route_id FOREIGN KEY (route_id) REFERENCES linehaul_route(route_id)
);

-- --------------------------------------------------------------------
-- telemetry_event   (Ontology: TelemetryEvent (streaming))
-- Grain: One event off the streaming bus (PLC, GPS, WMS counters).
-- --------------------------------------------------------------------
CREATE TABLE telemetry_event (
    event_id                   VARCHAR(20) NOT NULL,
    event_ts                   TIMESTAMP NOT NULL,
    event_type                 VARCHAR(20) NOT NULL,
    severity                   VARCHAR(8) NOT NULL,
    hub_id                     VARCHAR(16),
    vehicle_id                 VARCHAR(16),
    metric_value               DECIMAL(12,2),
    source_system              VARCHAR(16) NOT NULL,
    CONSTRAINT pk_telemetry_event PRIMARY KEY (event_id),
    CONSTRAINT fk_telemetry_event_hub_id FOREIGN KEY (hub_id) REFERENCES hub(hub_id),
    CONSTRAINT fk_telemetry_event_vehicle_id FOREIGN KEY (vehicle_id) REFERENCES transport_vehicle(vehicle_id)
);

-- --------------------------------------------------------------------
-- action_type   (Ontology: ActionType (catalog / typed tool))
-- Grain: Definition of a governed write-back the agent may propose.
-- --------------------------------------------------------------------
CREATE TABLE action_type (
    action_name                VARCHAR(32) NOT NULL,
    description                VARCHAR(160) NOT NULL,
    parameter_schema           VARCHAR(200) NOT NULL,
    side_effect_systems        VARCHAR(40) NOT NULL,
    required_permission        VARCHAR(40) NOT NULL,
    human_in_loop              BOOLEAN NOT NULL,
    CONSTRAINT pk_action_type PRIMARY KEY (action_name)
);

-- --------------------------------------------------------------------
-- action_execution_log   (Ontology: ActionExecution (audit trail))
-- Grain: One proposed/approved/executed action instance = the audit record.
-- --------------------------------------------------------------------
CREATE TABLE action_execution_log (
    execution_id               VARCHAR(20) NOT NULL,
    action_name                VARCHAR(32) NOT NULL,
    parameters_json            VARCHAR(300) NOT NULL,
    proposed_by                VARCHAR(32) NOT NULL,
    approved_by                VARCHAR(40),
    status                     VARCHAR(12) NOT NULL,
    proposed_ts                TIMESTAMP NOT NULL,
    decided_ts                 TIMESTAMP,
    executed_ts                TIMESTAMP,
    target_system_ack          VARCHAR(60),
    sensitivity_marking        VARCHAR(24) NOT NULL,
    result_summary             VARCHAR(160),
    CONSTRAINT pk_action_execution_log PRIMARY KEY (execution_id),
    CONSTRAINT fk_action_execution_log_action_name FOREIGN KEY (action_name) REFERENCES action_type(action_name)
);

-- ===================================================================
-- SAMPLE DATA
-- ===================================================================

-- hub: 10 rows
INSERT INTO hub (hub_id, hub_name, hub_type, city, country, latitude, longitude, processing_capacity_hr, current_utilization_pct, status, operating_window, sensitivity_marking, last_telemetry_ts) VALUES ('HUB-FRA-01', 'Frankfurt Mega-Hub', 'MEGA_HUB', 'Frankfurt', 'DE', 50.0379, 8.5622, 42000, 97, 'DEGRADED', '05:00-23:30', 'OPS-INTERNAL', '2026-08-20 06:12:44');
INSERT INTO hub (hub_id, hub_name, hub_type, city, country, latitude, longitude, processing_capacity_hr, current_utilization_pct, status, operating_window, sensitivity_marking, last_telemetry_ts) VALUES ('HUB-CGN-01', 'Cologne Regional Hub', 'REGIONAL_HUB', 'Cologne', 'DE', 50.8659, 7.1427, 18000, 61, 'OPERATIONAL', '05:30-22:30', 'OPS-INTERNAL', '2026-08-20 06:12:31');
INSERT INTO hub (hub_id, hub_name, hub_type, city, country, latitude, longitude, processing_capacity_hr, current_utilization_pct, status, operating_window, sensitivity_marking, last_telemetry_ts) VALUES ('HUB-NUE-01', 'Nuremberg Regional Hub', 'REGIONAL_HUB', 'Nuremberg', 'DE', 49.4987, 11.0783, 15000, 54, 'OPERATIONAL', '05:30-22:30', 'OPS-INTERNAL', '2026-08-20 06:12:38');
INSERT INTO hub (hub_id, hub_name, hub_type, city, country, latitude, longitude, processing_capacity_hr, current_utilization_pct, status, operating_window, sensitivity_marking, last_telemetry_ts) VALUES ('HUB-STR-01', 'Stuttgart Regional Hub', 'REGIONAL_HUB', 'Stuttgart', 'DE', 48.6899, 9.195, 13000, 66, 'OPERATIONAL', '05:30-22:00', 'OPS-INTERNAL', '2026-08-20 06:12:29');
INSERT INTO hub (hub_id, hub_name, hub_type, city, country, latitude, longitude, processing_capacity_hr, current_utilization_pct, status, operating_window, sensitivity_marking, last_telemetry_ts) VALUES ('HUB-HAM-01', 'Hamburg Regional Hub', 'REGIONAL_HUB', 'Hamburg', 'DE', 53.6304, 9.9882, 16000, 72, 'OPERATIONAL', '05:00-22:30', 'OPS-INTERNAL', '2026-08-20 06:12:19');
INSERT INTO hub (hub_id, hub_name, hub_type, city, country, latitude, longitude, processing_capacity_hr, current_utilization_pct, status, operating_window, sensitivity_marking, last_telemetry_ts) VALUES ('HUB-MUC-01', 'Munich Regional Hub', 'REGIONAL_HUB', 'Munich', 'DE', 48.3538, 11.7861, 14000, 70, 'OPERATIONAL', '05:30-22:30', 'OPS-INTERNAL', '2026-08-20 06:12:22');
INSERT INTO hub (hub_id, hub_name, hub_type, city, country, latitude, longitude, processing_capacity_hr, current_utilization_pct, status, operating_window, sensitivity_marking, last_telemetry_ts) VALUES ('HUB-BER-01', 'Berlin Regional Hub', 'REGIONAL_HUB', 'Berlin', 'DE', 52.3667, 13.5033, 15500, 68, 'OPERATIONAL', '05:00-22:30', 'OPS-INTERNAL', '2026-08-20 06:12:41');
INSERT INTO hub (hub_id, hub_name, hub_type, city, country, latitude, longitude, processing_capacity_hr, current_utilization_pct, status, operating_window, sensitivity_marking, last_telemetry_ts) VALUES ('HUB-LYS-01', 'Lyon Cross-Border Hub', 'REGIONAL_HUB', 'Lyon', 'FR', 45.7256, 5.0811, 12000, 58, 'OPERATIONAL', '06:00-22:00', 'OPS-INTERNAL', '2026-08-20 06:12:10');
INSERT INTO hub (hub_id, hub_name, hub_type, city, country, latitude, longitude, processing_capacity_hr, current_utilization_pct, status, operating_window, sensitivity_marking, last_telemetry_ts) VALUES ('HUB-MIL-01', 'Milan Cross-Border Hub', 'REGIONAL_HUB', 'Milan', 'IT', 45.6306, 8.7281, 12500, 63, 'OPERATIONAL', '06:00-22:00', 'OPS-INTERNAL', '2026-08-20 06:12:05');
INSERT INTO hub (hub_id, hub_name, hub_type, city, country, latitude, longitude, processing_capacity_hr, current_utilization_pct, status, operating_window, sensitivity_marking, last_telemetry_ts) VALUES ('HUB-VIE-01', 'Vienna Cross-Border Hub', 'REGIONAL_HUB', 'Vienna', 'AT', 48.1103, 16.5697, 11000, 60, 'OPERATIONAL', '06:00-22:00', 'OPS-INTERNAL', '2026-08-20 06:12:02');

-- carrier: 6 rows
INSERT INTO carrier (carrier_id, carrier_name, carrier_type, home_country, reliability_rating, cost_index, certifications) VALUES ('CAR-INH', 'National Carrier In-House Linehaul', 'IN_HOUSE', 'DE', 94, 1.0, 'ADR;GDP');
INSERT INTO carrier (carrier_id, carrier_name, carrier_type, home_country, reliability_rating, cost_index, certifications) VALUES ('CAR-DBS', 'Contract Hauler Alpha (road)', 'CONTRACT_3PL', 'DE', 91, 1.08, 'ADR');
INSERT INTO carrier (carrier_id, carrier_name, carrier_type, home_country, reliability_rating, cost_index, certifications) VALUES ('CAR-GLS', 'Contract Hauler Beta (express)', 'CONTRACT_3PL', 'DE', 89, 1.12, 'GDP');
INSERT INTO carrier (carrier_id, carrier_name, carrier_type, home_country, reliability_rating, cost_index, certifications) VALUES ('CAR-DPD', 'Contract Hauler Gamma (X-border)', 'CONTRACT_3PL', 'FR', 88, 1.05, NULL);
INSERT INTO carrier (carrier_id, carrier_name, carrier_type, home_country, reliability_rating, cost_index, certifications) VALUES ('CAR-RAIL', 'Rail Freight Partner', 'CONTRACT_3PL', 'DE', 96, 0.82, NULL);
INSERT INTO carrier (carrier_id, carrier_name, carrier_type, home_country, reliability_rating, cost_index, certifications) VALUES ('CAR-AIR', 'Air Cargo Partner', 'CONTRACT_3PL', 'DE', 92, 2.4, NULL);

-- driver: 10 rows
INSERT INTO driver (driver_id, driver_name, home_hub_id, carrier_id, hours_available_today, status, certifications) VALUES ('DRV-0001', 'Lena Hoffmann', 'HUB-CGN-01', 'CAR-INH', 6.5, 'ON_DUTY', 'C+E;ADR');
INSERT INTO driver (driver_id, driver_name, home_hub_id, carrier_id, hours_available_today, status, certifications) VALUES ('DRV-0002', 'Mattis Vogel', 'HUB-CGN-01', 'CAR-INH', 4.0, 'ON_DUTY', 'C+E');
INSERT INTO driver (driver_id, driver_name, home_hub_id, carrier_id, hours_available_today, status, certifications) VALUES ('DRV-0003', 'Sofia Braun', 'HUB-NUE-01', 'CAR-INH', 7.5, 'ON_DUTY', 'C+E;ADR');
INSERT INTO driver (driver_id, driver_name, home_hub_id, carrier_id, hours_available_today, status, certifications) VALUES ('DRV-0004', 'Jonas Keller', 'HUB-NUE-01', 'CAR-DBS', 3.0, 'ON_DUTY', 'C+E');
INSERT INTO driver (driver_id, driver_name, home_hub_id, carrier_id, hours_available_today, status, certifications) VALUES ('DRV-0005', 'Amelie Fischer', 'HUB-STR-01', 'CAR-INH', 5.5, 'ON_DUTY', 'C+E');
INSERT INTO driver (driver_id, driver_name, home_hub_id, carrier_id, hours_available_today, status, certifications) VALUES ('DRV-0006', 'Noah Wagner', 'HUB-STR-01', 'CAR-DBS', 8.0, 'RESTING', 'C+E;ADR');
INSERT INTO driver (driver_id, driver_name, home_hub_id, carrier_id, hours_available_today, status, certifications) VALUES ('DRV-0007', 'Emil Richter', 'HUB-FRA-01', 'CAR-INH', 2.0, 'ON_DUTY', 'C+E;ADR');
INSERT INTO driver (driver_id, driver_name, home_hub_id, carrier_id, hours_available_today, status, certifications) VALUES ('DRV-0008', 'Clara Schulz', 'HUB-MUC-01', 'CAR-GLS', 6.0, 'ON_DUTY', 'C+E');
INSERT INTO driver (driver_id, driver_name, home_hub_id, carrier_id, hours_available_today, status, certifications) VALUES ('DRV-0009', 'Paul Neumann', 'HUB-BER-01', 'CAR-INH', 7.0, 'ON_DUTY', 'C+E');
INSERT INTO driver (driver_id, driver_name, home_hub_id, carrier_id, hours_available_today, status, certifications) VALUES ('DRV-0010', 'Marie Zimmermann', 'HUB-LYS-01', 'CAR-DPD', 5.0, 'ON_DUTY', 'C+E');

-- linehaul_route: 14 rows
INSERT INTO linehaul_route (route_id, origin_hub_id, destination_hub_id, distance_km, planned_transit_min, mode, active_carrier_id, departure_time, reliability_pct, status) VALUES ('LH-FRA-CGN-01', 'HUB-FRA-01', 'HUB-CGN-01', 191, 150, 'ROAD', 'CAR-INH', '18:00', 93, 'ACTIVE');
INSERT INTO linehaul_route (route_id, origin_hub_id, destination_hub_id, distance_km, planned_transit_min, mode, active_carrier_id, departure_time, reliability_pct, status) VALUES ('LH-FRA-NUE-01', 'HUB-FRA-01', 'HUB-NUE-01', 224, 165, 'ROAD', 'CAR-INH', '18:30', 92, 'ACTIVE');
INSERT INTO linehaul_route (route_id, origin_hub_id, destination_hub_id, distance_km, planned_transit_min, mode, active_carrier_id, departure_time, reliability_pct, status) VALUES ('LH-FRA-STR-01', 'HUB-FRA-01', 'HUB-STR-01', 204, 150, 'ROAD', 'CAR-DBS', '19:00', 90, 'ACTIVE');
INSERT INTO linehaul_route (route_id, origin_hub_id, destination_hub_id, distance_km, planned_transit_min, mode, active_carrier_id, departure_time, reliability_pct, status) VALUES ('LH-CGN-FRA-01', 'HUB-CGN-01', 'HUB-FRA-01', 191, 150, 'ROAD', 'CAR-INH', '20:00', 93, 'ACTIVE');
INSERT INTO linehaul_route (route_id, origin_hub_id, destination_hub_id, distance_km, planned_transit_min, mode, active_carrier_id, departure_time, reliability_pct, status) VALUES ('LH-NUE-FRA-01', 'HUB-NUE-01', 'HUB-FRA-01', 224, 165, 'ROAD', 'CAR-INH', '20:15', 92, 'ACTIVE');
INSERT INTO linehaul_route (route_id, origin_hub_id, destination_hub_id, distance_km, planned_transit_min, mode, active_carrier_id, departure_time, reliability_pct, status) VALUES ('LH-STR-FRA-01', 'HUB-STR-01', 'HUB-FRA-01', 204, 150, 'ROAD', 'CAR-DBS', '20:30', 90, 'ACTIVE');
INSERT INTO linehaul_route (route_id, origin_hub_id, destination_hub_id, distance_km, planned_transit_min, mode, active_carrier_id, departure_time, reliability_pct, status) VALUES ('LH-CGN-NUE-01', 'HUB-CGN-01', 'HUB-NUE-01', 410, 300, 'ROAD', 'CAR-DBS', '17:30', 89, 'ACTIVE');
INSERT INTO linehaul_route (route_id, origin_hub_id, destination_hub_id, distance_km, planned_transit_min, mode, active_carrier_id, departure_time, reliability_pct, status) VALUES ('LH-STR-NUE-01', 'HUB-STR-01', 'HUB-NUE-01', 210, 155, 'ROAD', 'CAR-INH', '19:30', 91, 'ACTIVE');
INSERT INTO linehaul_route (route_id, origin_hub_id, destination_hub_id, distance_km, planned_transit_min, mode, active_carrier_id, departure_time, reliability_pct, status) VALUES ('LH-FRA-HAM-01', 'HUB-FRA-01', 'HUB-HAM-01', 492, 320, 'ROAD', 'CAR-INH', '16:00', 90, 'ACTIVE');
INSERT INTO linehaul_route (route_id, origin_hub_id, destination_hub_id, distance_km, planned_transit_min, mode, active_carrier_id, departure_time, reliability_pct, status) VALUES ('LH-FRA-MUC-01', 'HUB-FRA-01', 'HUB-MUC-01', 392, 255, 'RAIL', 'CAR-RAIL', '15:30', 96, 'ACTIVE');
INSERT INTO linehaul_route (route_id, origin_hub_id, destination_hub_id, distance_km, planned_transit_min, mode, active_carrier_id, departure_time, reliability_pct, status) VALUES ('LH-FRA-BER-01', 'HUB-FRA-01', 'HUB-BER-01', 545, 345, 'ROAD', 'CAR-INH', '16:30', 89, 'ACTIVE');
INSERT INTO linehaul_route (route_id, origin_hub_id, destination_hub_id, distance_km, planned_transit_min, mode, active_carrier_id, departure_time, reliability_pct, status) VALUES ('LH-FRA-LYS-01', 'HUB-FRA-01', 'HUB-LYS-01', 698, 455, 'ROAD', 'CAR-DPD', '14:00', 88, 'ACTIVE');
INSERT INTO linehaul_route (route_id, origin_hub_id, destination_hub_id, distance_km, planned_transit_min, mode, active_carrier_id, departure_time, reliability_pct, status) VALUES ('LH-FRA-MIL-01', 'HUB-FRA-01', 'HUB-MIL-01', 521, 90, 'AIR', 'CAR-AIR', '13:00', 95, 'ACTIVE');
INSERT INTO linehaul_route (route_id, origin_hub_id, destination_hub_id, distance_km, planned_transit_min, mode, active_carrier_id, departure_time, reliability_pct, status) VALUES ('LH-NUE-VIE-01', 'HUB-NUE-01', 'HUB-VIE-01', 488, 310, 'ROAD', 'CAR-DPD', '17:00', 88, 'ACTIVE');

-- transport_vehicle: 12 rows
INSERT INTO transport_vehicle (vehicle_id, registration_plate, vehicle_type, capacity_parcels, current_latitude, current_longitude, current_route_id, assigned_driver_id, status, fuel_or_soc_pct, telemetry_ts) VALUES ('VEH-DE-1042', 'F-PX 1042', 'SEMI_TRAILER', 1800, 50.1, 8.65, 'LH-FRA-CGN-01', 'DRV-0007', 'EN_ROUTE', 61, '2026-08-20 06:11:50');
INSERT INTO transport_vehicle (vehicle_id, registration_plate, vehicle_type, capacity_parcels, current_latitude, current_longitude, current_route_id, assigned_driver_id, status, fuel_or_soc_pct, telemetry_ts) VALUES ('VEH-DE-1043', 'F-PX 1043', 'SEMI_TRAILER', 1800, 50.86, 7.2, 'LH-CGN-FRA-01', 'DRV-0001', 'LOADING', 88, '2026-08-20 06:11:44');
INSERT INTO transport_vehicle (vehicle_id, registration_plate, vehicle_type, capacity_parcels, current_latitude, current_longitude, current_route_id, assigned_driver_id, status, fuel_or_soc_pct, telemetry_ts) VALUES ('VEH-DE-1051', 'K-PX 1051', 'SWAP_BODY', 1400, 50.87, 7.14, NULL, 'DRV-0002', 'AVAILABLE', 95, '2026-08-20 06:11:39');
INSERT INTO transport_vehicle (vehicle_id, registration_plate, vehicle_type, capacity_parcels, current_latitude, current_longitude, current_route_id, assigned_driver_id, status, fuel_or_soc_pct, telemetry_ts) VALUES ('VEH-DE-1052', 'K-PX 1052', 'SEMI_TRAILER', 1800, 50.87, 7.14, NULL, NULL, 'AVAILABLE', 73, '2026-08-20 06:11:31');
INSERT INTO transport_vehicle (vehicle_id, registration_plate, vehicle_type, capacity_parcels, current_latitude, current_longitude, current_route_id, assigned_driver_id, status, fuel_or_soc_pct, telemetry_ts) VALUES ('VEH-DE-1077', 'N-PX 1077', 'SEMI_TRAILER', 1800, 49.5, 11.08, NULL, 'DRV-0003', 'AVAILABLE', 90, '2026-08-20 06:11:22');
INSERT INTO transport_vehicle (vehicle_id, registration_plate, vehicle_type, capacity_parcels, current_latitude, current_longitude, current_route_id, assigned_driver_id, status, fuel_or_soc_pct, telemetry_ts) VALUES ('VEH-DE-1078', 'N-PX 1078', 'SWAP_BODY', 1400, 49.5, 11.08, NULL, NULL, 'LOADING', 64, '2026-08-20 06:11:18');
INSERT INTO transport_vehicle (vehicle_id, registration_plate, vehicle_type, capacity_parcels, current_latitude, current_longitude, current_route_id, assigned_driver_id, status, fuel_or_soc_pct, telemetry_ts) VALUES ('VEH-DE-1090', 'S-PX 1090', 'SEMI_TRAILER', 1800, 48.69, 9.2, NULL, 'DRV-0005', 'AVAILABLE', 81, '2026-08-20 06:11:12');
INSERT INTO transport_vehicle (vehicle_id, registration_plate, vehicle_type, capacity_parcels, current_latitude, current_longitude, current_route_id, assigned_driver_id, status, fuel_or_soc_pct, telemetry_ts) VALUES ('VEH-DE-1091', 'S-PX 1091', 'RIGID_TRUCK', 900, 48.69, 9.2, NULL, NULL, 'MAINTENANCE', 40, '2026-08-20 05:50:03');
INSERT INTO transport_vehicle (vehicle_id, registration_plate, vehicle_type, capacity_parcels, current_latitude, current_longitude, current_route_id, assigned_driver_id, status, fuel_or_soc_pct, telemetry_ts) VALUES ('VEH-DE-1120', 'M-PX 1120', 'SEMI_TRAILER', 1800, 48.35, 11.79, NULL, 'DRV-0008', 'AVAILABLE', 77, '2026-08-20 06:11:05');
INSERT INTO transport_vehicle (vehicle_id, registration_plate, vehicle_type, capacity_parcels, current_latitude, current_longitude, current_route_id, assigned_driver_id, status, fuel_or_soc_pct, telemetry_ts) VALUES ('VEH-DE-1140', 'B-PX 1140', 'SEMI_TRAILER', 1800, 52.37, 13.5, 'LH-FRA-BER-01', 'DRV-0009', 'EN_ROUTE', 58, '2026-08-20 06:10:58');
INSERT INTO transport_vehicle (vehicle_id, registration_plate, vehicle_type, capacity_parcels, current_latitude, current_longitude, current_route_id, assigned_driver_id, status, fuel_or_soc_pct, telemetry_ts) VALUES ('VEH-FR-2210', '69-PX-2210', 'SEMI_TRAILER', 1800, 45.73, 5.08, NULL, 'DRV-0010', 'AVAILABLE', 84, '2026-08-20 06:10:47');
INSERT INTO transport_vehicle (vehicle_id, registration_plate, vehicle_type, capacity_parcels, current_latitude, current_longitude, current_route_id, assigned_driver_id, status, fuel_or_soc_pct, telemetry_ts) VALUES ('VEH-AIR-9001', 'D-ACARGO', 'CARGO_JET', 9000, 50.03, 8.56, 'LH-FRA-MIL-01', NULL, 'LOADING', 100, '2026-08-20 06:10:30');

-- shipment_consignment: 20 rows
INSERT INTO shipment_consignment (consignment_id, parcel_count, service_type, sla_level, origin_hub_id, target_hub_id, current_hub_id, sla_deadline, total_weight_kg, declared_value_eur, status, sensitivity_marking) VALUES ('CN-2026-0001', 1420, 'EXPRESS_INTL', 'SLA_A_NEXTDAY', 'HUB-LYS-01', 'HUB-FRA-01', 'HUB-LYS-01', '2026-08-20 20:00:00', 5120.5, 184300.0, 'AT_RISK', 'CUSTOMER-PII');
INSERT INTO shipment_consignment (consignment_id, parcel_count, service_type, sla_level, origin_hub_id, target_hub_id, current_hub_id, sla_deadline, total_weight_kg, declared_value_eur, status, sensitivity_marking) VALUES ('CN-2026-0002', 980, 'EXPRESS_INTL', 'SLA_A_NEXTDAY', 'HUB-MIL-01', 'HUB-FRA-01', 'HUB-MIL-01', '2026-08-20 20:00:00', 3510.0, 142900.0, 'AT_RISK', 'CUSTOMER-PII');
INSERT INTO shipment_consignment (consignment_id, parcel_count, service_type, sla_level, origin_hub_id, target_hub_id, current_hub_id, sla_deadline, total_weight_kg, declared_value_eur, status, sensitivity_marking) VALUES ('CN-2026-0003', 2100, 'DOMESTIC_PRIO', 'SLA_B_48H', 'HUB-MUC-01', 'HUB-FRA-01', 'HUB-MUC-01', '2026-08-21 12:00:00', 7480.0, 96500.0, 'AT_RISK', 'COMMERCIAL-CONF');
INSERT INTO shipment_consignment (consignment_id, parcel_count, service_type, sla_level, origin_hub_id, target_hub_id, current_hub_id, sla_deadline, total_weight_kg, declared_value_eur, status, sensitivity_marking) VALUES ('CN-2026-0004', 1750, 'EXPRESS_INTL', 'SLA_A_NEXTDAY', 'HUB-VIE-01', 'HUB-FRA-01', 'HUB-NUE-01', '2026-08-20 20:00:00', 6220.0, 210400.0, 'AT_RISK', 'CUSTOMER-PII');
INSERT INTO shipment_consignment (consignment_id, parcel_count, service_type, sla_level, origin_hub_id, target_hub_id, current_hub_id, sla_deadline, total_weight_kg, declared_value_eur, status, sensitivity_marking) VALUES ('CN-2026-0005', 640, 'DOMESTIC_PRIO', 'SLA_B_48H', 'HUB-BER-01', 'HUB-FRA-01', 'HUB-BER-01', '2026-08-21 12:00:00', 2280.0, 54800.0, 'IN_TRANSIT', 'COMMERCIAL-CONF');
INSERT INTO shipment_consignment (consignment_id, parcel_count, service_type, sla_level, origin_hub_id, target_hub_id, current_hub_id, sla_deadline, total_weight_kg, declared_value_eur, status, sensitivity_marking) VALUES ('CN-2026-0006', 3200, 'ECONOMY', 'SLA_C_ECON', 'HUB-HAM-01', 'HUB-FRA-01', 'HUB-HAM-01', '2026-08-22 18:00:00', 11040.0, 73200.0, 'IN_TRANSIT', 'OPS-INTERNAL');
INSERT INTO shipment_consignment (consignment_id, parcel_count, service_type, sla_level, origin_hub_id, target_hub_id, current_hub_id, sla_deadline, total_weight_kg, declared_value_eur, status, sensitivity_marking) VALUES ('CN-2026-0007', 1180, 'EXPRESS_INTL', 'SLA_A_NEXTDAY', 'HUB-STR-01', 'HUB-FRA-01', 'HUB-STR-01', '2026-08-20 20:00:00', 4130.0, 121600.0, 'AT_RISK', 'CUSTOMER-PII');
INSERT INTO shipment_consignment (consignment_id, parcel_count, service_type, sla_level, origin_hub_id, target_hub_id, current_hub_id, sla_deadline, total_weight_kg, declared_value_eur, status, sensitivity_marking) VALUES ('CN-2026-0008', 2450, 'DOMESTIC_PRIO', 'SLA_B_48H', 'HUB-CGN-01', 'HUB-FRA-01', 'HUB-CGN-01', '2026-08-21 12:00:00', 8580.0, 88700.0, 'AT_HUB', 'COMMERCIAL-CONF');
INSERT INTO shipment_consignment (consignment_id, parcel_count, service_type, sla_level, origin_hub_id, target_hub_id, current_hub_id, sla_deadline, total_weight_kg, declared_value_eur, status, sensitivity_marking) VALUES ('CN-2026-0009', 1560, 'EXPRESS_INTL', 'SLA_A_NEXTDAY', 'HUB-NUE-01', 'HUB-FRA-01', 'HUB-NUE-01', '2026-08-20 20:00:00', 5460.0, 167800.0, 'AT_RISK', 'CUSTOMER-PII');
INSERT INTO shipment_consignment (consignment_id, parcel_count, service_type, sla_level, origin_hub_id, target_hub_id, current_hub_id, sla_deadline, total_weight_kg, declared_value_eur, status, sensitivity_marking) VALUES ('CN-2026-0010', 890, 'DOMESTIC_PRIO', 'SLA_B_48H', 'HUB-MUC-01', 'HUB-FRA-01', 'HUB-MUC-01', '2026-08-21 12:00:00', 3115.0, 47200.0, 'IN_TRANSIT', 'OPS-INTERNAL');
INSERT INTO shipment_consignment (consignment_id, parcel_count, service_type, sla_level, origin_hub_id, target_hub_id, current_hub_id, sla_deadline, total_weight_kg, declared_value_eur, status, sensitivity_marking) VALUES ('CN-2026-0011', 1340, 'EXPRESS_INTL', 'SLA_A_NEXTDAY', 'HUB-LYS-01', 'HUB-FRA-01', 'HUB-LYS-01', '2026-08-20 20:00:00', 4690.0, 151200.0, 'AT_RISK', 'CUSTOMER-PII');
INSERT INTO shipment_consignment (consignment_id, parcel_count, service_type, sla_level, origin_hub_id, target_hub_id, current_hub_id, sla_deadline, total_weight_kg, declared_value_eur, status, sensitivity_marking) VALUES ('CN-2026-0012', 720, 'ECONOMY', 'SLA_C_ECON', 'HUB-MIL-01', 'HUB-FRA-01', 'HUB-MIL-01', '2026-08-22 18:00:00', 2520.0, 31900.0, 'IN_TRANSIT', 'OPS-INTERNAL');
INSERT INTO shipment_consignment (consignment_id, parcel_count, service_type, sla_level, origin_hub_id, target_hub_id, current_hub_id, sla_deadline, total_weight_kg, declared_value_eur, status, sensitivity_marking) VALUES ('CN-2026-0013', 1980, 'DOMESTIC_PRIO', 'SLA_B_48H', 'HUB-STR-01', 'HUB-FRA-01', 'HUB-STR-01', '2026-08-21 12:00:00', 6930.0, 79400.0, 'AT_RISK', 'COMMERCIAL-CONF');
INSERT INTO shipment_consignment (consignment_id, parcel_count, service_type, sla_level, origin_hub_id, target_hub_id, current_hub_id, sla_deadline, total_weight_kg, declared_value_eur, status, sensitivity_marking) VALUES ('CN-2026-0014', 510, 'EXPRESS_INTL', 'SLA_A_NEXTDAY', 'HUB-VIE-01', 'HUB-FRA-01', 'HUB-VIE-01', '2026-08-20 20:00:00', 1785.0, 66300.0, 'IN_TRANSIT', 'CUSTOMER-PII');
INSERT INTO shipment_consignment (consignment_id, parcel_count, service_type, sla_level, origin_hub_id, target_hub_id, current_hub_id, sla_deadline, total_weight_kg, declared_value_eur, status, sensitivity_marking) VALUES ('CN-2026-0015', 2670, 'DOMESTIC_PRIO', 'SLA_B_48H', 'HUB-BER-01', 'HUB-FRA-01', 'HUB-BER-01', '2026-08-21 12:00:00', 9345.0, 102700.0, 'IN_TRANSIT', 'COMMERCIAL-CONF');
INSERT INTO shipment_consignment (consignment_id, parcel_count, service_type, sla_level, origin_hub_id, target_hub_id, current_hub_id, sla_deadline, total_weight_kg, declared_value_eur, status, sensitivity_marking) VALUES ('CN-2026-0016', 1230, 'EXPRESS_INTL', 'SLA_A_NEXTDAY', 'HUB-CGN-01', 'HUB-FRA-01', 'HUB-CGN-01', '2026-08-20 20:00:00', 4305.0, 133800.0, 'AT_RISK', 'CUSTOMER-PII');
INSERT INTO shipment_consignment (consignment_id, parcel_count, service_type, sla_level, origin_hub_id, target_hub_id, current_hub_id, sla_deadline, total_weight_kg, declared_value_eur, status, sensitivity_marking) VALUES ('CN-2026-0017', 860, 'ECONOMY', 'SLA_C_ECON', 'HUB-HAM-01', 'HUB-FRA-01', 'HUB-HAM-01', '2026-08-22 18:00:00', 3010.0, 28600.0, 'IN_TRANSIT', 'OPS-INTERNAL');
INSERT INTO shipment_consignment (consignment_id, parcel_count, service_type, sla_level, origin_hub_id, target_hub_id, current_hub_id, sla_deadline, total_weight_kg, declared_value_eur, status, sensitivity_marking) VALUES ('CN-2026-0018', 1490, 'DOMESTIC_PRIO', 'SLA_B_48H', 'HUB-NUE-01', 'HUB-FRA-01', 'HUB-NUE-01', '2026-08-21 12:00:00', 5215.0, 71100.0, 'AT_HUB', 'COMMERCIAL-CONF');
INSERT INTO shipment_consignment (consignment_id, parcel_count, service_type, sla_level, origin_hub_id, target_hub_id, current_hub_id, sla_deadline, total_weight_kg, declared_value_eur, status, sensitivity_marking) VALUES ('CN-2026-0019', 2050, 'EXPRESS_INTL', 'SLA_A_NEXTDAY', 'HUB-MUC-01', 'HUB-FRA-01', 'HUB-MUC-01', '2026-08-20 20:00:00', 7175.0, 198500.0, 'AT_RISK', 'CUSTOMER-PII');
INSERT INTO shipment_consignment (consignment_id, parcel_count, service_type, sla_level, origin_hub_id, target_hub_id, current_hub_id, sla_deadline, total_weight_kg, declared_value_eur, status, sensitivity_marking) VALUES ('CN-2026-0020', 1610, 'DOMESTIC_PRIO', 'SLA_B_48H', 'HUB-LYS-01', 'HUB-FRA-01', 'HUB-LYS-01', '2026-08-21 12:00:00', 5635.0, 84900.0, 'IN_TRANSIT', 'COMMERCIAL-CONF');

-- consignment_vehicle_assignment: 15 rows
INSERT INTO consignment_vehicle_assignment (assignment_id, consignment_id, vehicle_id, route_id, leg_sequence, assigned_ts, status) VALUES ('ASG-0001', 'CN-2026-0001', 'VEH-FR-2210', 'LH-FRA-LYS-01', 1, '2026-08-20 05:40:00', 'PLANNED');
INSERT INTO consignment_vehicle_assignment (assignment_id, consignment_id, vehicle_id, route_id, leg_sequence, assigned_ts, status) VALUES ('ASG-0002', 'CN-2026-0002', 'VEH-AIR-9001', 'LH-FRA-MIL-01', 1, '2026-08-20 05:41:00', 'PLANNED');
INSERT INTO consignment_vehicle_assignment (assignment_id, consignment_id, vehicle_id, route_id, leg_sequence, assigned_ts, status) VALUES ('ASG-0003', 'CN-2026-0004', 'VEH-DE-1077', 'LH-NUE-FRA-01', 2, '2026-08-20 05:42:00', 'PLANNED');
INSERT INTO consignment_vehicle_assignment (assignment_id, consignment_id, vehicle_id, route_id, leg_sequence, assigned_ts, status) VALUES ('ASG-0004', 'CN-2026-0005', 'VEH-DE-1140', 'LH-FRA-BER-01', 1, '2026-08-20 05:20:00', 'ACTIVE');
INSERT INTO consignment_vehicle_assignment (assignment_id, consignment_id, vehicle_id, route_id, leg_sequence, assigned_ts, status) VALUES ('ASG-0005', 'CN-2026-0007', 'VEH-DE-1090', 'LH-STR-FRA-01', 1, '2026-08-20 05:44:00', 'PLANNED');
INSERT INTO consignment_vehicle_assignment (assignment_id, consignment_id, vehicle_id, route_id, leg_sequence, assigned_ts, status) VALUES ('ASG-0006', 'CN-2026-0008', 'VEH-DE-1051', 'LH-CGN-FRA-01', 1, '2026-08-20 05:45:00', 'PLANNED');
INSERT INTO consignment_vehicle_assignment (assignment_id, consignment_id, vehicle_id, route_id, leg_sequence, assigned_ts, status) VALUES ('ASG-0007', 'CN-2026-0009', 'VEH-DE-1078', 'LH-NUE-FRA-01', 1, '2026-08-20 05:46:00', 'PLANNED');
INSERT INTO consignment_vehicle_assignment (assignment_id, consignment_id, vehicle_id, route_id, leg_sequence, assigned_ts, status) VALUES ('ASG-0008', 'CN-2026-0003', 'VEH-DE-1120', 'LH-FRA-MUC-01', 1, '2026-08-20 05:47:00', 'PLANNED');
INSERT INTO consignment_vehicle_assignment (assignment_id, consignment_id, vehicle_id, route_id, leg_sequence, assigned_ts, status) VALUES ('ASG-0009', 'CN-2026-0016', 'VEH-DE-1043', 'LH-CGN-FRA-01', 1, '2026-08-20 05:48:00', 'ACTIVE');
INSERT INTO consignment_vehicle_assignment (assignment_id, consignment_id, vehicle_id, route_id, leg_sequence, assigned_ts, status) VALUES ('ASG-0010', 'CN-2026-0013', 'VEH-DE-1090', 'LH-STR-FRA-01', 2, '2026-08-20 05:49:00', 'PLANNED');
INSERT INTO consignment_vehicle_assignment (assignment_id, consignment_id, vehicle_id, route_id, leg_sequence, assigned_ts, status) VALUES ('ASG-0011', 'CN-2026-0006', 'VEH-DE-1042', 'LH-FRA-HAM-01', 1, '2026-08-20 05:35:00', 'ACTIVE');
INSERT INTO consignment_vehicle_assignment (assignment_id, consignment_id, vehicle_id, route_id, leg_sequence, assigned_ts, status) VALUES ('ASG-0012', 'CN-2026-0018', 'VEH-DE-1077', 'LH-NUE-FRA-01', 1, '2026-08-20 05:50:00', 'PLANNED');
INSERT INTO consignment_vehicle_assignment (assignment_id, consignment_id, vehicle_id, route_id, leg_sequence, assigned_ts, status) VALUES ('ASG-0013', 'CN-2026-0019', 'VEH-DE-1120', 'LH-FRA-MUC-01', 2, '2026-08-20 05:51:00', 'PLANNED');
INSERT INTO consignment_vehicle_assignment (assignment_id, consignment_id, vehicle_id, route_id, leg_sequence, assigned_ts, status) VALUES ('ASG-0014', 'CN-2026-0011', 'VEH-FR-2210', 'LH-FRA-LYS-01', 2, '2026-08-20 05:52:00', 'PLANNED');
INSERT INTO consignment_vehicle_assignment (assignment_id, consignment_id, vehicle_id, route_id, leg_sequence, assigned_ts, status) VALUES ('ASG-0015', 'CN-2026-0015', 'VEH-DE-1140', 'LH-FRA-BER-01', 2, '2026-08-20 05:53:00', 'ACTIVE');

-- telemetry_event: 15 rows
INSERT INTO telemetry_event (event_id, event_ts, event_type, severity, hub_id, vehicle_id, metric_value, source_system) VALUES ('EV-0001', '2026-08-20 05:58:12', 'CONVEYOR_FAULT', 'CRITICAL', 'HUB-FRA-01', NULL, 3.0, 'PLC-SCADA');
INSERT INTO telemetry_event (event_id, event_ts, event_type, severity, hub_id, vehicle_id, metric_value, source_system) VALUES ('EV-0002', '2026-08-20 06:01:44', 'VOLUME_SURGE', 'CRITICAL', 'HUB-FRA-01', NULL, 131.0, 'WMS-COUNTER');
INSERT INTO telemetry_event (event_id, event_ts, event_type, severity, hub_id, vehicle_id, metric_value, source_system) VALUES ('EV-0003', '2026-08-20 06:02:10', 'VOLUME_SURGE', 'WARN', 'HUB-FRA-01', NULL, 118.0, 'WMS-COUNTER');
INSERT INTO telemetry_event (event_id, event_ts, event_type, severity, hub_id, vehicle_id, metric_value, source_system) VALUES ('EV-0004', '2026-08-20 06:03:02', 'DELAY', 'WARN', NULL, 'VEH-DE-1042', 22.0, 'TMS-GPS');
INSERT INTO telemetry_event (event_id, event_ts, event_type, severity, hub_id, vehicle_id, metric_value, source_system) VALUES ('EV-0005', '2026-08-20 06:03:55', 'GPS_PING', 'INFO', NULL, 'VEH-DE-1077', 0.0, 'TMS-GPS');
INSERT INTO telemetry_event (event_id, event_ts, event_type, severity, hub_id, vehicle_id, metric_value, source_system) VALUES ('EV-0006', '2026-08-20 06:04:20', 'CONVEYOR_FAULT', 'WARN', 'HUB-FRA-01', NULL, 1.0, 'PLC-SCADA');
INSERT INTO telemetry_event (event_id, event_ts, event_type, severity, hub_id, vehicle_id, metric_value, source_system) VALUES ('EV-0007', '2026-08-20 06:05:11', 'VOLUME_SURGE', 'CRITICAL', 'HUB-FRA-01', NULL, 127.0, 'WMS-COUNTER');
INSERT INTO telemetry_event (event_id, event_ts, event_type, severity, hub_id, vehicle_id, metric_value, source_system) VALUES ('EV-0008', '2026-08-20 06:05:40', 'GPS_PING', 'INFO', NULL, 'VEH-DE-1090', 0.0, 'TMS-GPS');
INSERT INTO telemetry_event (event_id, event_ts, event_type, severity, hub_id, vehicle_id, metric_value, source_system) VALUES ('EV-0009', '2026-08-20 06:06:03', 'TEMP_BREACH', 'WARN', NULL, 'VEH-AIR-9001', 8.5, 'IOT-COLDCHAIN');
INSERT INTO telemetry_event (event_id, event_ts, event_type, severity, hub_id, vehicle_id, metric_value, source_system) VALUES ('EV-0010', '2026-08-20 06:06:48', 'DELAY', 'INFO', NULL, 'VEH-DE-1140', 6.0, 'TMS-GPS');
INSERT INTO telemetry_event (event_id, event_ts, event_type, severity, hub_id, vehicle_id, metric_value, source_system) VALUES ('EV-0011', '2026-08-20 06:07:22', 'VOLUME_SURGE', 'WARN', 'HUB-FRA-01', NULL, 121.0, 'WMS-COUNTER');
INSERT INTO telemetry_event (event_id, event_ts, event_type, severity, hub_id, vehicle_id, metric_value, source_system) VALUES ('EV-0012', '2026-08-20 06:08:05', 'GPS_PING', 'INFO', NULL, 'VEH-DE-1120', 0.0, 'TMS-GPS');
INSERT INTO telemetry_event (event_id, event_ts, event_type, severity, hub_id, vehicle_id, metric_value, source_system) VALUES ('EV-0013', '2026-08-20 06:08:59', 'CONVEYOR_FAULT', 'CRITICAL', 'HUB-FRA-01', NULL, 2.0, 'PLC-SCADA');
INSERT INTO telemetry_event (event_id, event_ts, event_type, severity, hub_id, vehicle_id, metric_value, source_system) VALUES ('EV-0014', '2026-08-20 06:09:30', 'DELAY', 'WARN', NULL, 'VEH-DE-1043', 15.0, 'TMS-GPS');
INSERT INTO telemetry_event (event_id, event_ts, event_type, severity, hub_id, vehicle_id, metric_value, source_system) VALUES ('EV-0015', '2026-08-20 06:10:12', 'VOLUME_SURGE', 'CRITICAL', 'HUB-FRA-01', NULL, 129.0, 'WMS-COUNTER');

-- action_type: 4 rows
INSERT INTO action_type (action_name, description, parameter_schema, side_effect_systems, required_permission, human_in_loop) VALUES ('RerouteLinehaul', 'Divert a consignment (or batch) to an alternate target hub via an alternate carrier, updating TMS routing and WMS inbound plans.', 'RerouteLinehaul(consignment_id: Consignment, new_target_hub_id: Hub, alternate_carrier_id: Carrier)', 'TMS;WMS', 'ROLE_OPS_DISPATCH_WRITE', TRUE);
INSERT INTO action_type (action_name, description, parameter_schema, side_effect_systems, required_permission, human_in_loop) VALUES ('ReallocateHubCapacity', 'Extend a hub''s processing window and set a divert threshold so inbound volume above the threshold auto-diverts.', 'ReallocateHubCapacity(hub_id: Hub, additional_hours: Int, divert_threshold_pct: Int)', 'WMS;LABOR-MGMT', 'ROLE_OPS_CAPACITY_WRITE', TRUE);
INSERT INTO action_type (action_name, description, parameter_schema, side_effect_systems, required_permission, human_in_loop) VALUES ('ReassignVehicle', 'Bind an AVAILABLE vehicle+driver to a route leg, respecting EU drive-time hours.', 'ReassignVehicle(vehicle_id: Vehicle, route_id: LinehaulRoute, driver_id: Driver)', 'TMS;FLEET', 'ROLE_OPS_FLEET_WRITE', TRUE);
INSERT INTO action_type (action_name, description, parameter_schema, side_effect_systems, required_permission, human_in_loop) VALUES ('NotifyCustomerSLA', 'Emit a proactive SLA-risk notification for affected consignments to the CRM/notification bus.', 'NotifyCustomerSLA(consignment_id: Consignment, new_eta: Timestamp)', 'CRM;NOTIFY', 'ROLE_OPS_COMMS_WRITE', FALSE);

-- action_execution_log: 6 rows
INSERT INTO action_execution_log (execution_id, action_name, parameters_json, proposed_by, approved_by, status, proposed_ts, decided_ts, executed_ts, target_system_ack, sensitivity_marking, result_summary) VALUES ('AX-0001', 'ReallocateHubCapacity', '{hub_id:HUB-FRA-01, additional_hours:0, divert_threshold_pct:85}', 'agent://ops/ops-agent', 'e.sundstrom@carrier.eu', 'EXECUTED', '2026-08-20 06:12:50', '2026-08-20 06:14:10', '2026-08-20 06:14:12', 'WMS-ACK:WMS-88213; LABOR-ACK:LM-4471', 'OPS-INTERNAL', 'FRA divert threshold armed at 85%; inbound above threshold flagged for reroute.');
INSERT INTO action_execution_log (execution_id, action_name, parameters_json, proposed_by, approved_by, status, proposed_ts, decided_ts, executed_ts, target_system_ack, sensitivity_marking, result_summary) VALUES ('AX-0002', 'RerouteLinehaul', '{consignment_id:CN-2026-0004, new_target_hub_id:HUB-NUE-01, alternate_carrier_id:CAR-INH}', 'agent://ops/ops-agent', 'e.sundstrom@carrier.eu', 'EXECUTED', '2026-08-20 06:13:02', '2026-08-20 06:14:40', '2026-08-20 06:14:42', 'TMS-ACK:TMS-55901; WMS-ACK:WMS-88220', 'CUSTOMER-PII', '1,750 parcels re-targeted FRA->NUE; ETA within SLA_A window.');
INSERT INTO action_execution_log (execution_id, action_name, parameters_json, proposed_by, approved_by, status, proposed_ts, decided_ts, executed_ts, target_system_ack, sensitivity_marking, result_summary) VALUES ('AX-0003', 'RerouteLinehaul', '{consignment_id:CN-2026-0009, new_target_hub_id:HUB-NUE-01, alternate_carrier_id:CAR-INH}', 'agent://ops/ops-agent', 'e.sundstrom@carrier.eu', 'EXECUTED', '2026-08-20 06:13:20', '2026-08-20 06:14:55', '2026-08-20 06:14:57', 'TMS-ACK:TMS-55902; WMS-ACK:WMS-88221', 'CUSTOMER-PII', '1,560 parcels re-targeted FRA->NUE; capacity confirmed at NUE.');
INSERT INTO action_execution_log (execution_id, action_name, parameters_json, proposed_by, approved_by, status, proposed_ts, decided_ts, executed_ts, target_system_ack, sensitivity_marking, result_summary) VALUES ('AX-0004', 'RerouteLinehaul', '{consignment_id:CN-2026-0007, new_target_hub_id:HUB-STR-01, alternate_carrier_id:CAR-DBS}', 'agent://ops/ops-agent', 'e.sundstrom@carrier.eu', 'PROPOSED', '2026-08-20 06:13:35', NULL, NULL, NULL, 'CUSTOMER-PII', 'Awaiting operator decision; STR spare capacity 34%.');
INSERT INTO action_execution_log (execution_id, action_name, parameters_json, proposed_by, approved_by, status, proposed_ts, decided_ts, executed_ts, target_system_ack, sensitivity_marking, result_summary) VALUES ('AX-0005', 'ReassignVehicle', '{vehicle_id:VEH-DE-1051, route_id:LH-NUE-FRA-01, driver_id:DRV-0002}', 'agent://ops/ops-agent', 'e.sundstrom@carrier.eu', 'APPROVED', '2026-08-20 06:13:48', '2026-08-20 06:15:05', NULL, NULL, 'OPS-INTERNAL', 'Spare swap-body assigned to strengthen NUE inbound; execution queued.');
INSERT INTO action_execution_log (execution_id, action_name, parameters_json, proposed_by, approved_by, status, proposed_ts, decided_ts, executed_ts, target_system_ack, sensitivity_marking, result_summary) VALUES ('AX-0006', 'RerouteLinehaul', '{consignment_id:CN-2026-0019, new_target_hub_id:HUB-MUC-01, alternate_carrier_id:CAR-GLS}', 'agent://ops/ops-agent', NULL, 'REJECTED', '2026-08-20 06:14:02', '2026-08-20 06:15:20', NULL, NULL, 'CUSTOMER-PII', 'Operator rejected: MUC labor window insufficient; alternative sought.');

-- ===================================================================
-- SECONDARY INDEXES (traversal performance)
-- ===================================================================
CREATE INDEX ix_route_origin       ON linehaul_route(origin_hub_id);
CREATE INDEX ix_route_dest         ON linehaul_route(destination_hub_id);
CREATE INDEX ix_consign_target     ON shipment_consignment(target_hub_id);
CREATE INDEX ix_consign_status     ON shipment_consignment(status);
CREATE INDEX ix_vehicle_route      ON transport_vehicle(current_route_id);
CREATE INDEX ix_asg_consignment    ON consignment_vehicle_assignment(consignment_id);
CREATE INDEX ix_telemetry_hub      ON telemetry_event(hub_id);
CREATE INDEX ix_axlog_action       ON action_execution_log(action_name);

-- ===================================================================
-- DEMO VIEWS  (the graph traversals the AI agent relies on)
-- ===================================================================
-- 1) Consignments at risk at a degraded hub (detection query)
CREATE OR REPLACE VIEW v_at_risk_consignments AS
SELECT c.consignment_id, c.parcel_count, c.sla_level, c.sla_deadline,
       c.current_hub_id, c.target_hub_id, h.status AS target_hub_status
FROM   shipment_consignment c
JOIN   hub h ON h.hub_id = c.target_hub_id
WHERE  h.status <> 'OPERATIONAL'
  AND  c.status IN ('AT_RISK','IN_TRANSIT','AT_HUB');

-- 2) Neighbouring hubs with spare throughput (constraint evaluation)
CREATE OR REPLACE VIEW v_spare_capacity AS
SELECT h.hub_id, h.hub_name, h.processing_capacity_hr, h.current_utilization_pct,
       ROUND(h.processing_capacity_hr * (100 - h.current_utilization_pct) / 100.0) AS spare_parcels_hr
FROM   hub h
WHERE  h.status = 'OPERATIONAL';

-- 3) Full audit trail with the human approver (governance query)
CREATE OR REPLACE VIEW v_action_audit AS
SELECT x.execution_id, x.action_name, x.status, x.proposed_by, x.approved_by,
       x.proposed_ts, x.executed_ts, x.target_system_ack, x.sensitivity_marking
FROM   action_execution_log x
ORDER  BY x.proposed_ts;

COMMIT;
