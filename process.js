const box = require('box-node-sdk')

const slackConfig = require('./slackConfig.json')
const boxConfig = require('./boxConfig.json')

const express = require('express') 
const app = express()
const axios = require('axios')

const port = process.env.PORT || 3000
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

const client = box.getPreconfiguredInstance(boxConfig)
  .getAppAuthClient('enterprise')
                
app.post('/event', (req, res) => {
  if (!req.body || req.body.token !== slackConfig.verificationToken) {
    res.status(400).send('Slack Verification Failed')
  }
  
  if (req.body.type === 'url_verification') {
    handleUrlVerification(req, res) 
  } else if (req.body.type === 'event_callback') { 
    handleEventCallback(req, res) 
  } else if (req.body.command === '/boxadd') { 
    handleCommand(req, res) 
  } else {
    res.status(400).send()
  }
})

/**
 * Handles event webhook verification challenge.
 */
const handleUrlVerification = (req, res) => {
  console.log('Received URL verification challenge')
  res.send({ challenge: req.body.challenge })
}

/**
 * Handle incoming `event_callback` webhooks
 */
const handleEventCallback = async (req, res) => {
  const eventType = req.body.event.type
  const channelId = req.body.event.channel
  const userId = req.body.event.user

  const user = await getSlackUser(userId)
  await syncSlackUsers(user, eventType, channelId)
  res.send()
}

/**
 * Converts a slack user ID to a full user objecy
 */
const getSlackUser = async (userId) => {
  const response = await axios.get(
    `https://slack.com/api/users.info?token=${slackConfig.botToken}&user=${userId}`
  )

  if (response.data && response.data.user) {
    return response.data.user
  } else {
    console.error('No user data found')
  }
}

/**
 * Sync a user to a group, or if the user is a bot, sync the whole
 * channel to a group.
 */
const syncSlackUsers = async (user, event, channelId) => {
  console.log(`Received ${event} for ${user.name}`)

  const group = await getGroup(channelId)
  
  if (user.is_bot) {
    await syncChannelToGroup(channelId, group.id)
  } else if (user.profile.email) {
    if (event === 'member_joined_channel') {
      await addGroupUser(group.id, user.profile.email)
    } else if (event === 'member_left_channel') {
      await removeGroupUser(group.id, user.profile.email)
    }
  } 
}

/**
 * Finds or creates a group for a channel ID
 */
const getGroup = async (channelId) => {
  console.log(`Get group for channel ${channelId}`)

  const groupName = `slack-${channelId}`

  const groups = await client.groups.getAll()
  let group = groups.entries.filter(g => g.name === groupName)[0]
  if (!group) { 
    group = client.groups.create(groupName, { 
      description: 'Slack channel collaboration group', 
      invitability_level: 'all_managed_users' 
    })
  }

  return group
}

/**
 * Sync an entire channel to a group
 */
const syncChannelToGroup = async (channelId, groupId) => {
  console.log(`Syncing channel ${channelId} to group ${groupId}`)

  const response = await axios.get(
    `https://slack.com/api/conversations.members?token=${slackConfig.botToken}&channel=${channelId}&limit=100`
  )

  response.data.members.forEach(async (userId) => {
    const user = await getSlackUser(userId)
    if (user.profile.email && !user.is_bot) {
      await addGroupUser(groupId, user.profile.email)
    }
  })
}

/**
 * Adds a user to a group, checkin if it has not already been added
 */
const addGroupUser = async (groupId, email) => {
  console.log(`Adding ${email} to group ${groupId}`)

  const users = await client.enterprise.getUsers({filter_term: email})
  if (!users.entries[0]) { 
    console.error(`User ${email} not found`)
    return
  }

  const userId = users.entries[0].id  
  const memberships = await client.users.getGroupMemberships(userId)
  const existingMembership = memberships.entries.filter(m => m.user.id === userId)[0]
  if (existingMembership) {
    console.log(`User ${email} is already a member of group ${groupId}`)
    return 
  }

  const groupRole = client.groups.userRoles.MEMBER
  await client.groups.addUser(
    groupId, userId, { role: groupRole }
  )

  console.log(`Added ${email} to group #${groupId}`)
}
 
/**
 * Removes a user from a group
 */
const removeGroupUser = async (groupId, email) => {
  console.log(`Removing ${email} from group #${groupId}`)

  const memberships = await client.groups.getMemberships(groupId)
  const membership = memberships.entries.filter(m => m.user.login === email)[0]

  if (membership) {
    await client.groups.removeMembership(membership.id)
    console.log(`Removed ${email} from group #${groupId}`)
  } else {
    console.error(`User ${email} is not a member of group #${groupId}`)
  }
}

/**
 * Handles an incoming slah command, adding a group as
 * collaborators to the file or folder
 */
const handleCommand = async (req, res) => {
  const channelId = req.body.channel_id
  const userId = req.body.user_id
  const [itemType, itemId] = req.body.text.split(' ')

  if (
    !['file', 'folder'].includes(itemType) || isNaN(itemId)
  ) {
    res.send('Invalid input. Example usage: /boxadd file 123456')
  }

  const group = await getGroup(channelId)
  const slackUser = await getSlackUser(userId)
  const email = slackUser.profile.email
    
  const boxUsers = await client.enterprise.getUsers({filter_term: email})
  const boxUser = boxUsers.entries[0]

  if (!boxUser) {
    res.send(`Could not find a Box user with email ${email}`)
    return
  }

  client.asUser(boxUser.id)
  
  try {
    await client.collaborations.createWithGroupID(
      group.id,
      itemId, 
      client.collaborationRoles.VIEWER,
      { 
        type: itemType 
      }
    )
    res.send('Provided all users with access to item')
  } catch(error) {
    res.send('Could not provide all users access')
  }
}

app.listen(port, function(err) { 
  console.log("Server listening on PORT", port) 
})