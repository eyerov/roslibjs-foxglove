# Action client example

## Code

```js
import * as ROSLIB from '@eyerov/roslibjs-foxglove';

const ros = new ROSLIB.Ros({
  url: 'ws://localhost:8765',
});

const action = new ROSLIB.Action({
  ros: ros,
  name: '/fibonacci',
  actionType: 'example_interfaces/action/Fibonacci',
});

action.on('status', (goalId, status) => {
  console.log(goalId, ROSLIB.GoalStatus[status]);
});

const goalId = action.sendGoal(
  { order: 10 },
  (result) => {
    console.log('succeeded', result.sequence);
  },
  (feedback) => {
    console.log('feedback', feedback.sequence);
  },
  (error, result) => {
    console.log('failed', error, result);
  },
);

// Later, to stop it early:
action.cancelGoal(goalId);
```

## Code Explanation

This code is a simple ROS 2 action client with `@eyerov/roslibjs-foxglove`.

1. It creates a `ROSLIB.Ros` connection, then a `ROSLIB.Action` for the action `/fibonacci` of type `example_interfaces/action/Fibonacci`.

2. `sendGoal` sends the goal `{ order: 10 }` and returns the goal's ID, its UUID as a hex string.
   - The result callback is called with the result if the goal succeeds.
   - The feedback callback is called with every feedback message for this goal.
   - The failed callback is called with an error message if the goal is rejected, aborted or canceled, if the action server cannot be reached within `timeout` (5000 ms by default), or if the connection closes. For aborted and canceled goals it also gets the result the server returned.

3. Every change of a goal's state is emitted as a `status` event with a `ROSLIB.GoalStatus` value.

4. `cancelGoal` asks the server to cancel the goal. The goal still ends through the callbacks passed to `sendGoal` (usually the failed callback, with `'Goal was canceled'`).

## How it works

The Foxglove WebSocket protocol has no notion of actions, but a ROS 2 action is only a set of services and topics, which `ROSLIB.Action` uses directly:

| Name                          | Kind    | Purpose                                        |
| ----------------------------- | ------- | ---------------------------------------------- |
| `<name>/_action/send_goal`    | service | Submit a goal; the server accepts or rejects it |
| `<name>/_action/get_result`   | service | Answered when the goal has finished             |
| `<name>/_action/cancel_goal`  | service | Cancel a goal                                   |
| `<name>/_action/feedback`     | topic   | Feedback for all goals                          |
| `<name>/_action/status`       | topic   | Status of all goals                             |

Names containing `_action` are hidden in ROS 2, and Foxglove bridge does not advertise hidden names by default. Launch it with:

```sh
ros2 launch foxglove_bridge foxglove_bridge_launch.xml include_hidden:=true
```

Without that, the action's services are never advertised and every goal fails after `timeout`.

### Lost feedback with several goals at once

Foxglove bridge sizes its ROS subscription queue from the publisher's history depth, which DDS does not report, so it falls back to `min_qos_depth` (default 1). With a one-message queue, feedback published by two goals at nearly the same moment overwrites each other, and some goals miss feedback. This affects every topic the bridge relays, not only actions. Raise the floor when launching the bridge:

```sh
ros2 launch foxglove_bridge foxglove_bridge_launch.xml include_hidden:=true min_qos_depth:=10
```

Results are not affected: they are fetched with the `get_result` service.
