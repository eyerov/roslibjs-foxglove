# @eyerov/roslibjs-foxglove

EyeROV's fork of [tier4/roslibjs-foxglove](https://github.com/tier4/roslibjs-foxglove). It adds a ROS 2 [`ROSLIB.Action`](docs/action.md) client and fixes service calls against `foxglove.sdk.v1` servers (foxglove_bridge 3.x).

An implementation of [roslibjs](https://github.com/RobotWebTools/roslibjs)'s interfaces by using [Foxglove WebSocket Protocol](https://github.com/foxglove/ws-protocol).

roslibjs-foxglove is a client library that communicates with ROS 1 / 2 using [Foxglove bridge](https://docs.foxglove.dev/docs/connecting-to-data/ros-foxglove-bridge/). Unlike the [rosbridge](https://github.com/RobotWebTools/rosbridge_suite) used in the existing [roslibjs](https://github.com/RobotWebTools/roslibjs), Foxglove bridge provides extremely high performance, low latency, and low packet loss rate.

## Getting Started

### ROS side

Install and launch Foxglove bridge.

```sh
sudo apt install ros-$ROS_DISTRO-foxglove-bridge
roslaunch --screen foxglove_bridge foxglove_bridge.launch port:=8765 # for ROS 1
ros2 launch foxglove_bridge foxglove_bridge_launch.xml port:=8765 # for ROS 2
```

### JS / TS side

```sh
npm install https://github.com/eyerov/roslibjs-foxglove/releases/download/v0.1.0/eyerov-roslibjs-foxglove-0.1.0.tgz
```

## Supported features

### ROSLIB.Ros

|                    | Parameter           | Note                                     |
| ------------------ | ------------------- | ---------------------------------------- |
| :heavy_check_mark: | url                 |                                          |
|                    | groovyCompatibility |                                          |
|                    | transportLibrary    | Foxglove bridge only supports WebSocket. |
|                    | transportOptions    |                                          |

|                    | Method                    | Note |
| ------------------ | ------------------------- | ---- |
|                    | authenticate              |      |
|                    | callOnConnection          |      |
| :heavy_check_mark: | close                     |      |
| :heavy_check_mark: | connect                   |      |
|                    | decodeTypeDefs            |      |
|                    | getActionServers          |      |
|                    | getMessageDetails         |      |
|                    | getNodeDetails            |      |
|                    | getNodes                  |      |
|                    | getParams                 |      |
|                    | getServiceRequestDetails  |      |
|                    | getServiceResponseDetails |      |
| :heavy_check_mark: | getServices               |      |
|                    | getServicesForType        |      |
| :heavy_check_mark: | getServiceType            |      |
| :heavy_check_mark: | getTopics                 |      |
|                    | getTopicsAndRawTypes      |      |
|                    | getTopicsForType          |      |
| :heavy_check_mark: | getTopicType              |      |
|                    | sendEncodedMessage        |      |
|                    | setStatusLevel            |      |

### ROSLIB.Topic

|                    | Parameter          | Note                                              |
| ------------------ | ------------------ | ------------------------------------------------- |
| :heavy_check_mark: | ros                |                                                   |
| :heavy_check_mark: | name               |                                                   |
| :heavy_check_mark: | messageType        |                                                   |
|                    | compression        |                                                   |
|                    | throttle_rate      | Foxglove bridge does not support `throttle_rate`. |
|                    | queue_size         |                                                   |
|                    | latch              |                                                   |
|                    | queue_length       |                                                   |
|                    | reconnect_on_close |                                                   |

|                    | Method      | Note |
| ------------------ | ----------- | ---- |
| :heavy_check_mark: | advertise   |      |
| :heavy_check_mark: | publish     |      |
| :heavy_check_mark: | subscribe   |      |
|                    | toStream    |      |
| :heavy_check_mark: | unadvertise |      |
| :heavy_check_mark: | unsubscribe |      |

### ROSLIB.Service

|                    | Parameter   | Note |
| ------------------ | ----------- | ---- |
| :heavy_check_mark: | ros         |      |
| :heavy_check_mark: | name        |      |
| :heavy_check_mark: | serviceType |      |

|                    | Method      | Note |
| ------------------ | ----------- | ---- |
|                    | advertise   |      |
| :heavy_check_mark: | callService |      |

### ROSLIB.Action

ROS 2 only. Foxglove bridge must be launched with `include_hidden:=true`, because every action is made of hidden `<name>/_action/*` services and topics. See [docs/action.md](docs/action.md).

|                    | Parameter  | Note                                                         |
| ------------------ | ---------- | ------------------------------------------------------------ |
| :heavy_check_mark: | ros        |                                                              |
| :heavy_check_mark: | name       |                                                              |
| :heavy_check_mark: | actionType |                                                              |
| :heavy_check_mark: | timeout    | Not in roslibjs. Limit for send_goal / cancel_goal (5000 ms). |

|                    | Method       | Note                                                  |
| ------------------ | ------------ | ----------------------------------------------------- |
| :heavy_check_mark: | sendGoal     | Returns the goal UUID as hex.                         |
| :heavy_check_mark: | cancelGoal   |                                                       |
|                    | advertise    | Foxglove bridge cannot host services for the client. |
|                    | unadvertise  |                                                       |
|                    | sendFeedback |                                                       |
|                    | setSucceeded |                                                       |
|                    | setCanceled  |                                                       |
|                    | setFailed    |                                                       |

### ROSLIB.Param

|                    | Parameter | Note |
| ------------------ | --------- | ---- |
| :heavy_check_mark: | ros       |      |
| :heavy_check_mark: | name      |      |

|                    | Method | Note |
| ------------------ | ------ | ---- |
|                    | delete |      |
| :heavy_check_mark: | get    |      |
| :heavy_check_mark: | set    |      |

## License

@eyerov/roslibjs-foxglove is released under the Apache 2.0 license, like the original by TIER IV, Inc.
