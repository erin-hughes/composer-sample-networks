'use strict';

const AdminConnection = require('composer-admin').AdminConnection;
const BusinessNetworkConnection = require('composer-client').BusinessNetworkConnection;
const { BusinessNetworkDefinition, CertificateUtil, IdCard } = require('composer-common');
const path = require('path');

const chai = require('chai');
chai.should();
chai.use(require('chai-as-promised'));

const namespace = 'org.acme.loc';
const letterId = 'L123';

describe('Letters of Credit Network', () => {
    const cardStore = require('composer-common').NetworkCardStoreManager.getCardStore( { type: 'composer-wallet-inmemory' } );
    let adminConnection;
    let businessNetworkConnection;
    let factory;

    let alice;
    let bob;
    let rules;
    let productDetails;
    let letter;
    let letterRegistry;

    before(async () => {
        // Embedded connection used for local testing
        const connectionProfile = {
            name: 'embedded',
            'x-type': 'embedded'
        };
        // Generate certificates for use with the embedded connection
        const credentials = CertificateUtil.generate({ commonName: 'admin' });
        
        // PeerAdmin identity used with the admin connection to deploy business networks
        const deployerMetadata = {
            version: 1,
            userName: 'PeerAdmin',
            roles: [ 'PeerAdmin', 'ChannelAdmin' ]
        };

        const deployerCard = new IdCard(deployerMetadata, connectionProfile);
        deployerCard.setCredentials(credentials);

        const deployerCardName = 'PeerAdmin';
        adminConnection = new AdminConnection({ cardStore: cardStore });

        await adminConnection.importCard(deployerCardName, deployerCard);
        await adminConnection.connect(deployerCardName);
    });

    
    beforeEach(async () => {
        businessNetworkConnection = new BusinessNetworkConnection({ cardStore: cardStore });

        const adminUserName = 'admin';
        let adminCardName;
        const businessNetworkDefinition = await BusinessNetworkDefinition.fromDirectory(path.resolve(__dirname, '..'));

        // Install the Composer runtime for the new business network
        await adminConnection.install(businessNetworkDefinition);

        // Start the business network and configure a network admin identity
        const startOptions = {
            networkAdmins: [
                {
                    userName: adminUserName,
                    enrollmentSecret: 'adminpw'
                }
            ]
        };
        const adminCards = await adminConnection.start(businessNetworkDefinition.getName(), businessNetworkDefinition.getVersion(), startOptions);

        // Import the network admin identity for us to use
        adminCardName = `${adminUserName}@${businessNetworkDefinition.getName()}`;

        await adminConnection.importCard(adminCardName, adminCards.get(adminUserName));

        // Connect to the business network using the network admin identity
        await businessNetworkConnection.connect(adminCardName);

        factory = businessNetworkConnection.getBusinessNetwork().getFactory();

        // create alice participant
        alice = factory.newResource(namespace, 'Customer', 'alice');
        alice.name = 'Alice';
        alice.lastName= 'Hamilton';
        alice.bankName = 'Bank of Argentina';
        alice.companyName = 'QuickFix IT';
        
        // create bob participant
        bob = factory.newResource(namespace, 'Customer', 'bob');
        bob.name = 'Bob';
        bob.lastName= 'Bobbins';
        bob.bankName = 'Central Bank of Brussels';
        bob.companyName = 'Conga Computers';

        // add alice and bob participants to the registry
        const customerRegistry = await businessNetworkConnection.getParticipantRegistry(namespace + '.Customer');
        await customerRegistry.add(alice);
        await customerRegistry.add(bob);

        // create some rules for the letter
        rules = [];
        const rule1 = factory.newConcept(namespace, 'Rule');
        rule1.ruleId = 'rule1';
        rule1.ruleText = 'This is a test rule';
        rules.push(rule1);
        const rule2 = factory.newConcept(namespace, 'Rule');
        rule2.ruleId = 'rule2';
        rule2.ruleText = 'This is another test rule';
        rules.push(rule2);

        // create the product details
        productDetails = factory.newConcept(namespace, 'ProductDetails');
        productDetails.productType = 'Computers';
        productDetails.quantity = 100;
        productDetails.pricePerUnit = 250;

        // create a generic letter
        letter = factory.newResource(namespace, 'LetterOfCredit', letterId);
        letter.applicant = factory.newRelationship(namespace, 'Customer', alice.getIdentifier());
        letter.beneficiary = factory.newRelationship(namespace, 'Customer', bob.getIdentifier());
        letter.issuingBank = alice.bankName;
        letter.exportingBank = bob.bankName;
        letter.rules = rules;
        letter.productDetails = productDetails;
        letter.evidence = [];
        letter.approval = [];
        letter.status = 'AWAITING_APPROVAL';

        letterRegistry = await businessNetworkConnection.getAssetRegistry(namespace + '.LetterOfCredit');
        await letterRegistry.add(letter);
    });

    describe('InitialApplication', () => {
        it('should be able to create a letter of credit asset', async () => {
            // create and submit the InitialApplication transaction
            const initialApplicationTx = factory.newTransaction(namespace, 'InitialApplication');
            initialApplicationTx.letterId = 'newLetter';
            initialApplicationTx.applicant = factory.newRelationship(namespace, 'Customer', alice.getIdentifier());
            initialApplicationTx.beneficiary = factory.newRelationship(namespace, 'Customer', bob.getIdentifier());
            initialApplicationTx.rules = rules;
            initialApplicationTx.productDetails = productDetails;
            await businessNetworkConnection.submitTransaction(initialApplicationTx);

            const letterRegistry = await businessNetworkConnection.getAssetRegistry(namespace + '.LetterOfCredit');
            const letter = await letterRegistry.get('newLetter');

            letter.letterId.should.deep.equal('newLetter');
            letter.applicant.should.deep.equal(initialApplicationTx.applicant);
            letter.beneficiary.should.deep.equal(initialApplicationTx.beneficiary);
            letter.issuingBank.should.deep.equal(alice.bankName);
            letter.exportingBank.should.deep.equal(bob.bankName);
            letter.rules.should.deep.equal(rules);
            letter.productDetails.should.deep.equal(productDetails);
            letter.evidence.should.deep.equal([]);
            letter.approval.should.deep.equal([]);
            letter.status.should.deep.equal('AWAITING_APPROVAL');
        });
    });

    describe('Approve', () => {
        it('should update the approval array to show that a participant has approved the letter', async () => {
            // create and submit an Approve transaction
            const approveTx = factory.newTransaction(namespace, 'Approve');
            approveTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            approveTx.approvingParty = 'alice';
            await businessNetworkConnection.submitTransaction(approveTx);
            
            const approvedLetter = await letterRegistry.get(letterId);
            approvedLetter.approval.should.deep.equal(['alice']);
        });

        it('should not allow the same person to approve the letter twice', async () => {
            // update the letter to have already been approved by Alice
            let updatedLetter = await letterRegistry.get(letterId);
            updatedLetter.approval = ['alice'];
            await letterRegistry.update(updatedLetter);
            
            // attempt to submit the Approve transaction and check the error
            const approveTx = factory.newTransaction(namespace, 'Approve');
            approveTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            approveTx.approvingParty = 'alice';
            return businessNetworkConnection.submitTransaction(approveTx).should.be.rejectedWith('This person has already approved this letter of credit');
        });

        it('should mark the letter as \'approved\' when all four parties have approved the letter', async () => {
            // update the letter to have been approved by three people already
            let updatedLetter = await letterRegistry.get(letterId);
            updatedLetter.approval = ['alice', 'matias', 'ella'];
            await letterRegistry.update(updatedLetter);

            // create and submit an Approve transaction
            const approveTx = factory.newTransaction(namespace, 'Approve');
            approveTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            approveTx.approvingParty = 'bob';
            await businessNetworkConnection.submitTransaction(approveTx);
            
            const approvedLetter = await letterRegistry.get(letterId);
            approvedLetter.approval.should.deep.equal(['alice', 'matias', 'ella', 'bob']);
            approvedLetter.status.should.deep.equal('APPROVED');
        });

        it('should be unable to submit an Approve transaction on a letter that has already been closed', async () => {
            // update the letter to be closed
            let updatedLetter = await letterRegistry.get(letterId);
            updatedLetter.status = 'CLOSED';
            await letterRegistry.update(updatedLetter);

            // attempt to submit an Approve transaction and check the error
            const approveTx = factory.newTransaction(namespace, 'Approve');
            approveTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            approveTx.approvingParty = 'alice';
            return businessNetworkConnection.submitTransaction(approveTx).should.be.rejectedWith('This letter of credit has already been closed');
        });

        it('should be unable to submit an Approve transaction on a letter that has already been rejected', async () => {
            // update the letter to be closed
            let updatedLetter = await letterRegistry.get(letterId); 
            updatedLetter.status = 'REJECTED';
            await letterRegistry.update(updatedLetter);

            // attempt to submit an Approve transaction and check the error
            const approveTx = factory.newTransaction(namespace, 'Approve');
            approveTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            approveTx.approvingParty = 'alice';
            return businessNetworkConnection.submitTransaction(approveTx).should.be.rejectedWith('This letter of credit has already been closed');
        });
    });

    describe('Reject', () => {
        it('should allow the rejection of the letter before it is fully approved', async () => {
            // create and submit a Reject transaction
            const rejectTx = factory.newTransaction(namespace, 'Reject');
            rejectTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            rejectTx.closeReason = 'testing the Reject transaction';
            await businessNetworkConnection.submitTransaction(rejectTx);

            const rejectedLetter = await letterRegistry.get(letterId);
            rejectedLetter.status.should.deep.equal('REJECTED');
            rejectedLetter.closeReason.should.deep.equal('testing the Reject transaction');
        });

        it('should be unable to submit a Reject transaction on a letter that has already been closed', async () => {
            // update the letter to have already been closed
            let updatedLetter = await letterRegistry.get(letterId);
            updatedLetter.approval = ['alice', 'matias', 'ella', 'bob'];
            updatedLetter.status = 'CLOSED';
            await letterRegistry.update(updatedLetter);

            // attempt to submit a Reject transaction and check the error
            const rejectTx = factory.newTransaction(namespace, 'Reject');
            rejectTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            rejectTx.closeReason = 'testing the Reject transaction';
            return businessNetworkConnection.submitTransaction(rejectTx).should.be.rejectedWith('This letter of credit has already been closed');
        });

        it('should be unable to submit a Reject transaction on a letter that has already been rejected', async () => {
            // update the letter to have been rejected
            let updatedLetter = await letterRegistry.get(letterId);
            updatedLetter.status = 'REJECTED';
            await letterRegistry.update(updatedLetter);

            // attempt to submit a Reject transaction and check the error
            const rejectTx = factory.newTransaction(namespace, 'Reject');
            rejectTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            rejectTx.closeReason = 'testing the Reject transaction';
            return businessNetworkConnection.submitTransaction(rejectTx).should.be.rejectedWith('This letter of credit has already been closed');
        });
    });

    describe('SuggestChanges', () => {
        let newRules;
        before(async () => {
            // define a new rules array to be used in the transactions
            newRules = [];
            const rule1 = factory.newConcept(namespace, 'Rule');
            rule1.ruleId = 'newRule1';
            rule1.ruleText = 'This is an updated test rule';
            newRules.push(rule1);
            const rule2 = factory.newConcept(namespace, 'Rule');
            rule2.ruleId = 'newRule2';
            rule2.ruleText = 'This is another updated test rule';
            newRules.push(rule2);
        });

        it('should update the array of rules and reset the approval array', async () => {
            // create and submit a SuggestChanges transaction
            const suggestChangesTx = factory.newTransaction(namespace, 'SuggestChanges');
            suggestChangesTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            suggestChangesTx.rules = newRules;
            await businessNetworkConnection.submitTransaction(suggestChangesTx);

            const changedLetter = await letterRegistry.get(letterId);
            changedLetter.rules.should.deep.equal(newRules);
            changedLetter.approval.should.deep.equal([]);
        });

        it('should be unable to submit a SuggestChanges transaction on a letter that has already been shipped', async () => {
            // update the letter to have been shipped
            let updatedLetter = await letterRegistry.get(letterId);
            updatedLetter.approval = ['alice', 'matias', 'ella', 'bob'];
            updatedLetter.status = 'SHIPPED';
            await letterRegistry.update(updatedLetter);

            // attempt to submit a SuggestChanges transaction and check the error
            const suggestChangesTx = factory.newTransaction(namespace, 'SuggestChanges');
            suggestChangesTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            suggestChangesTx.rules = newRules
            return businessNetworkConnection.submitTransaction(suggestChangesTx).should.be.rejectedWith('The product has already been shipped');
        });

        it('should be unable to submit a SuggestChanges transaction on a letter that has already been received', async () => {
            // update the letter to have been shipped
            let updatedLetter = await letterRegistry.get(letterId);
            updatedLetter.approval = ['alice', 'matias', 'ella', 'bob'];
            updatedLetter.status = 'RECEIVED';
            await letterRegistry.update(updatedLetter);

            // attempt to submit a SuggestChanges transaction and check the error
            const suggestChangesTx = factory.newTransaction(namespace, 'SuggestChanges');
            suggestChangesTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            suggestChangesTx.rules = newRules
            return businessNetworkConnection.submitTransaction(suggestChangesTx).should.be.rejectedWith('The product has already been shipped');
        });


        it('should be unable to submit a SuggestChanges transaction on a letter that has already been closed', async () => {
            // update the letter to have already been closed
            let updatedLetter = await letterRegistry.get(letterId);
            updatedLetter.approval = ['alice', 'matias', 'ella', 'bob'];
            updatedLetter.status = 'CLOSED';
            await letterRegistry.update(updatedLetter);

            // attempt to submit a SuggestChanges transaction and check the error
            const suggestChangesTx = factory.newTransaction(namespace, 'SuggestChanges');
            suggestChangesTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            suggestChangesTx.rules = newRules
            return businessNetworkConnection.submitTransaction(suggestChangesTx).should.be.rejectedWith('This letter of credit has already been closed');
        });

        it('should be unable to submit a SuggestChanges transaction on a letter that has already been rejected', async () => {
            // update the letter to have been rejected
            let updatedLetter = await letterRegistry.get(letterId);
            updatedLetter.status = 'REJECTED';
            await letterRegistry.update(updatedLetter);

            // attempt to submit a SuggestChanges transaction and check the error
            const suggestChangesTx = factory.newTransaction(namespace, 'SuggestChanges');
            suggestChangesTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            suggestChangesTx.rules = newRules;
            return businessNetworkConnection.submitTransaction(suggestChangesTx).should.be.rejectedWith('This letter of credit has already been closed');
        });
    })

    describe('ShipProduct', () => {
       it('should not update the status if the letter has not been fully approved', async () => {
            // attempt to submit the ShipProduct transaction against the unapproved letter, and check the error
            const shipProductTx = factory.newTransaction(namespace, 'ShipProduct');
            shipProductTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            shipProductTx.evidence = 'asdfghjk';
            return businessNetworkConnection.submitTransaction(shipProductTx).should.be.rejectedWith('This letter needs to be fully approved before the product can be shipped');
        });

        it('should mark the letter as \'shipped\' if it has been fully approved', async () => {
            // update the created letter so that it is ready to be shipped
            let updatedLetter = await letterRegistry.get(letterId);
            updatedLetter.approval = ['alice', 'matias', 'ella', 'bob'];
            updatedLetter.status = 'APPROVED';
            await letterRegistry.update(updatedLetter);

            // create and submit a ShipProduct transaction
            const shipProductTx = factory.newTransaction(namespace, 'ShipProduct');
            shipProductTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            shipProductTx.evidence = 'asdfghjk';
            await businessNetworkConnection.submitTransaction(shipProductTx);

            const shippedLetter = await letterRegistry.get(letterId);
            shippedLetter.status.should.deep.equal('SHIPPED');
            shippedLetter.evidence.should.deep.equal(['asdfghjk']);
        });

        it('should do nothing if the letter has already been marked as \'shipped\'', async () => {
            // update the letter so that is has already been marked as shipped
            let updatedLetter = await letterRegistry.get(letterId);
            updatedLetter.approval = ['alice', 'matias', 'ella', 'bob'];
            updatedLetter.status = 'SHIPPED'
            await letterRegistry.update(updatedLetter);

            // attempt to submit the ShipProduct transaction and check the error
            const shipProductTx = factory.newTransaction(namespace, 'ShipProduct');
            shipProductTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            shipProductTx.evidence = 'asdfghjk';
            return businessNetworkConnection.submitTransaction(shipProductTx).should.be.rejectedWith('The product has already been shipped');
        });

        it('should be unable to submit a ShipProduct transaction on a letter that has already been closed', async () => {
            // update the letter to have already been closed
            let updatedLetter = await letterRegistry.get(letterId)
            updatedLetter.approval = ['alice', 'matias', 'ella', 'bob'];
            updatedLetter.status = 'CLOSED';
            await letterRegistry.update(updatedLetter);

            // attempt to submit a ShipProduct transaction and check the error
            const shipProductTx = factory.newTransaction(namespace, 'ShipProduct');
            shipProductTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            shipProductTx.evidence = 'asdfghjk';
            return businessNetworkConnection.submitTransaction(shipProductTx).should.be.rejectedWith('This letter of credit has already been closed');
        });

        it('should be unable to submit a ShipProduct transaction on a letter that has already been rejected', async () => {
            // update the letter to have been rejected
            let updatedLetter = await letterRegistry.get(letterId);
            updatedLetter.status = 'REJECTED';
            await letterRegistry.update(updatedLetter);

            // attempt to submit a ShipProduct transaction and check the error
            const shipProductTx = factory.newTransaction(namespace, 'ShipProduct');
            shipProductTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            shipProductTx.evidence = 'asdfghjk';
            return businessNetworkConnection.submitTransaction(shipProductTx).should.be.rejectedWith('This letter of credit has already been closed');
        });

    });

    describe('ReceiveProduct', () => {
        it('should not update the status if the letter has not yet been fully approved', async () => {
            // attempt to submit a ReceiveProduct transaction against the unshipped letter, and check the error
            const receiveProductTx = factory.newTransaction(namespace, 'ReceiveProduct');
            receiveProductTx. loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            return businessNetworkConnection.submitTransaction(receiveProductTx).should.be.rejectedWith('The product needs to be shipped before it can be received');
        });

        it('should not update the status if the letter has not been marked as \'shipped\'', async () => {
            // update the letter to be approved but not shipped
            let updatedLetter = await letterRegistry.get(letterId);
            updatedLetter.approval = ['alice', 'matias', 'ella', 'bob'];
            updatedLetter.status = 'APPROVED';
            await letterRegistry.update(updatedLetter);

            // attempt to submit a ReceiveProduct transaction against the unshipped letter, and check the error
            const receiveProductTx = factory.newTransaction(namespace, 'ReceiveProduct');
            receiveProductTx. loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            return businessNetworkConnection.submitTransaction(receiveProductTx).should.be.rejectedWith('The product needs to be shipped before it can be received');
        });

        it('should mark the letter as \'received\' if it has been shipped', async () => {
            // update the letter to be shipped
            let updatedLetter = await letterRegistry.get(letterId);
            updatedLetter.approval = ['alice', 'matias', 'ella', 'bob'];
            updatedLetter.status = 'SHIPPED';
            await letterRegistry.update(updatedLetter);

            // create and submit the ReceiveProduct transaction
            const receiveProductTx = factory.newTransaction(namespace, 'ReceiveProduct');
            receiveProductTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            await businessNetworkConnection.submitTransaction(receiveProductTx);

            const receivedLetter = await letterRegistry.get(letterId);
            receivedLetter.status.should.deep.equal('RECEIVED'); 
        });

        it('should do nothing if the letter has already been marked as \'received\'', async () => {
            // update the letter so that is has already been marked as received
            let updatedLetter = await letterRegistry.get(letterId);
            updatedLetter.approval = ['alice', 'matias', 'ella', 'bob'];
            updatedLetter.status = 'RECEIVED'
            await letterRegistry.update(updatedLetter);

            // attempt to submit the ReceiveProduct transaction and check the error
            const receiveProductTx = factory.newTransaction(namespace, 'ReceiveProduct');
            receiveProductTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            return businessNetworkConnection.submitTransaction(receiveProductTx).should.be.rejectedWith('The product has already been received');
        });

        it('should be unable to submit a ReceiveProduct transaction on a letter that has already been closed', async () => {
            // update the letter to have already been closed
            let updatedLetter = await letterRegistry.get(letterId);
            updatedLetter.approval = ['alice', 'matias', 'ella', 'bob'];
            updatedLetter.status = 'CLOSED';
            await letterRegistry.update(updatedLetter);

            // attempt to submit a ReceiveProduct transaction and check the error
            const receiveProductTx = factory.newTransaction(namespace, 'ReceiveProduct');
            receiveProductTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            return businessNetworkConnection.submitTransaction(receiveProductTx).should.be.rejectedWith('This letter of credit has already been closed');
        });

        it('should be unable to submit a ReceiveProduct transaction on a letter that has already been rejected', async () => {
            // update the letter to have been rejected
            let updatedLetter = await letterRegistry.get(letterId);
            updatedLetter.status = 'REJECTED';
            await letterRegistry.update(updatedLetter);

            // attempt to submit a ReceiveProduct transaction and check the error
            const receiveProductTx = factory.newTransaction(namespace, 'ReceiveProduct');
            receiveProductTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            return businessNetworkConnection.submitTransaction(receiveProductTx).should.be.rejectedWith('This letter of credit has already been closed');
        });

    });

    describe('Close', () => {
       it('should not close the letter if it is not marked as \'received\'', async () => {
            // attempt to submit a Close transaction and check the error
            const closeTx = factory.newTransaction(namespace, 'Close');
            closeTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            closeTx.closeReason = 'testing the Close transaction'; 
            return businessNetworkConnection.submitTransaction(closeTx).should.be.rejectedWith('Cannot close this letter of credit until it is fully approved and the product has been received by the applicant');
        });

        it('should mark the letter as closed', async () => {
            // update the letter so it is ready to close
            let updatedLetter = await letterRegistry.get(letterId);
            updatedLetter.approval = ['alice', 'matias', 'ella', 'bob'];
            updatedLetter.status = 'RECEIVED';
            await letterRegistry.update(updatedLetter);

            // create and submit a Close transaction
            const closeTx = factory.newTransaction(namespace, 'Close');
            closeTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            closeTx.closeReason = 'testing the Close transaction'; 
            await businessNetworkConnection.submitTransaction(closeTx);

            const closedLetter = await letterRegistry.get(letterId);
            closedLetter.status.should.deep.equal('CLOSED');
            closedLetter.closeReason.should.deep.equal('testing the Close transaction');
        });

        it('should be unable to submit a Close transaction on a letter that has already been closed', async () => {
            // update the letter to have already been closed
            let updatedLetter = await letterRegistry.get(letterId);
            updatedLetter.approval = ['alice', 'matias', 'ella', 'bob'];
            updatedLetter.status = 'CLOSED';
            await letterRegistry.update(updatedLetter);

            // attempt to submit a Close transaction and check the error
            const closeTx = factory.newTransaction(namespace, 'Close');
            closeTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            closeTx.closeReason = 'testing the Close transaction';
            return businessNetworkConnection.submitTransaction(closeTx).should.be.rejectedWith('This letter of credit has already been closed');
        });

        it('should be unable to submit a Close transaction on a letter that has already been rejected', async () => {
            // update the letter to have been rejected
            let updatedLetter = await letterRegistry.get(letterId);
            updatedLetter.status = 'REJECTED';
            await letterRegistry.update(updatedLetter);

            // attempt to submit a Close transaction and check the error
            const closeTx = factory.newTransaction(namespace, 'Close');
            closeTx.loc = factory.newRelationship(namespace, 'LetterOfCredit', letterId);
            closeTx.closeReason = 'testing the Close transaction';
            return businessNetworkConnection.submitTransaction(closeTx).should.be.rejectedWith('This letter of credit has already been closed');
        });
    });

});
